CLASS zcl_ado_st03_reader DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Reads the ST03N USERTCODE aggregate (user x transaction) via
    " SWNC_COLLECTOR_GET_AGGREGATES - the API and field list verified
    " against A4H and the customer's RD1 (docu/06-s4-integration/
    " api-matrix.md). The FM returns whole internal tables per
    " (component, period); this class loops the monthly periods of the
    " requested window, aggregates, and caches the result per window
    " for the lifetime of the session so OData paging does not refetch.
    "
    " NOTE (matrix follow-up 7): the exact semantics of COUNT vs DCOUNT
    " must be validated against the ST03N UI for one known period. Until
    " then COUNT is treated as executions and dialog steps are COUNT
    " itself for DIALOG task-type rows.
    "---------------------------------------------------------------

    TYPES: BEGIN OF ty_tx_usage,
             transaction_code   TYPE c LENGTH 20,
             period_from        TYPE d,
             period_to          TYPE d,
             execution_count    TYPE int8,
             dialog_step_count  TYPE int8,
             distinct_user_cnt  TYPE i,
             total_resp_ms      TYPE p LENGTH 16 DECIMALS 2,
             avg_resp_ms        TYPE p LENGTH 16 DECIMALS 2,
             total_cpu_ms       TYPE p LENGTH 16 DECIMALS 2,
             total_db_ms        TYPE p LENGTH 16 DECIMALS 2,
           END OF ty_tx_usage,
           ty_tx_usage_t TYPE STANDARD TABLE OF ty_tx_usage WITH EMPTY KEY.

    TYPES: BEGIN OF ty_user_tx,
             user_key          TYPE c LENGTH 64,
             transaction_code  TYPE c LENGTH 20,
             period_from       TYPE d,
             period_to         TYPE d,
             execution_count   TYPE int8,
             dialog_step_count TYPE int8,
           END OF ty_user_tx,
           ty_user_tx_t TYPE STANDARD TABLE OF ty_user_tx WITH EMPTY KEY.

    CLASS-METHODS get_window
      IMPORTING iv_from           TYPE d
                iv_to             TYPE d
                iv_pseudonymise   TYPE abap_bool DEFAULT abap_true
                iv_top_users      TYPE i DEFAULT 20
      EXPORTING et_tx_usage       TYPE ty_tx_usage_t
                et_user_tx        TYPE ty_user_tx_t.

  PRIVATE SECTION.
    " Named table type: RETURNING parameters cannot use inline/generic
    " table declarations.
    TYPES ty_date_t TYPE STANDARD TABLE OF d WITH EMPTY KEY.

    TYPES: BEGIN OF ty_cache,
             cache_key TYPE string,
             tx_usage  TYPE ty_tx_usage_t,
             user_tx   TYPE ty_user_tx_t,
           END OF ty_cache.
    CLASS-DATA gt_cache TYPE STANDARD TABLE OF ty_cache WITH EMPTY KEY.

    CLASS-METHODS month_starts
      IMPORTING iv_from          TYPE d
                iv_to            TYPE d
      RETURNING VALUE(rt_months) TYPE ty_date_t.
ENDCLASS.


CLASS zcl_ado_st03_reader IMPLEMENTATION.

  METHOD get_window.
    CLEAR: et_tx_usage, et_user_tx.

    DATA(lv_cache_key) = |{ iv_from }::{ iv_to }::{ iv_pseudonymise }::{ iv_top_users }|.
    READ TABLE gt_cache INTO DATA(ls_hit) WITH KEY cache_key = lv_cache_key.
    IF sy-subrc = 0.
      et_tx_usage = ls_hit-tx_usage.
      et_user_tx  = ls_hit-user_tx.
      RETURN.
    ENDIF.

    " Raw accumulation across the monthly periods of the window.
    TYPES: BEGIN OF ty_raw,
             account  TYPE c LENGTH 64,
             entry_id TYPE c LENGTH 72,
             count    TYPE int8,
             respti   TYPE p LENGTH 16 DECIMALS 2,
             cputi    TYPE p LENGTH 16 DECIMALS 2,
             dbti     TYPE p LENGTH 16 DECIMALS 2,
           END OF ty_raw.
    DATA lt_raw TYPE HASHED TABLE OF ty_raw
      WITH UNIQUE KEY account entry_id.

    " Typed on the row structure the probe confirmed, not on a table type
    " whose row we have not verified.
    DATA lt_usertcode TYPE STANDARD TABLE OF swncaggusertcode WITH EMPTY KEY.

    " Every exporting parameter goes in as ITS OWN declared type: literals
    " raised CALL_FUNCTION_CONFLICT_TYPE at runtime on RD1 (the FM interface
    " checks field types strictly for dynamic calls).
    DATA lv_component  TYPE swnchostname.
    DATA lv_sysid      TYPE swncsysid.
    DATA lv_periodtype TYPE swncperitype.
    DATA lv_periodstrt TYPE swncdatum.
    lv_component  = 'TOTAL'.
    lv_sysid      = sy-sysid.
    lv_periodtype = 'M'.

    LOOP AT month_starts( iv_from = iv_from iv_to = iv_to ) INTO DATA(lv_month).
      CLEAR lt_usertcode.
      lv_periodstrt = lv_month.
      CALL FUNCTION 'SWNC_COLLECTOR_GET_AGGREGATES'
        EXPORTING
          component     = lv_component
          assigndsys    = lv_sysid
          periodtype    = lv_periodtype
          periodstrt    = lv_periodstrt
        TABLES
          usertcode     = lt_usertcode
        EXCEPTIONS
          no_data_found = 1
          OTHERS        = 2.
      IF sy-subrc <> 0.
        CONTINUE. "Missing months are normal (retention, young systems).
      ENDIF.

      LOOP AT lt_usertcode ASSIGNING FIELD-SYMBOL(<ls_agg>).
        DATA(lv_tcode) = condense( CONV string( <ls_agg>-entry_id ) ).
        IF lv_tcode IS INITIAL.
          CONTINUE.
        ENDIF.
        READ TABLE lt_raw ASSIGNING FIELD-SYMBOL(<ls_raw>)
          WITH TABLE KEY account = <ls_agg>-account entry_id = lv_tcode.
        IF sy-subrc <> 0.
          INSERT VALUE ty_raw( account = <ls_agg>-account entry_id = lv_tcode )
            INTO TABLE lt_raw ASSIGNING <ls_raw>.
        ENDIF.
        <ls_raw>-count  = <ls_raw>-count  + <ls_agg>-count.
        <ls_raw>-respti = <ls_raw>-respti + <ls_agg>-respti.
        <ls_raw>-cputi  = <ls_raw>-cputi  + <ls_agg>-cputi.
        " DB time = direct + sequential reads + changes (verified columns).
        <ls_raw>-dbti   = <ls_raw>-dbti
                        + <ls_agg>-readdirti + <ls_agg>-readseqti + <ls_agg>-chngti.
      ENDLOOP.
    ENDLOOP.

    " --- per-tcode rollup with distinct users --------------------------------
    TYPES: BEGIN OF ty_tx_build,
             entry_id TYPE c LENGTH 20,
             row      TYPE ty_tx_usage,
             users    TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line,
           END OF ty_tx_build.
    DATA lt_build TYPE HASHED TABLE OF ty_tx_build WITH UNIQUE KEY entry_id.

    LOOP AT lt_raw ASSIGNING <ls_raw>.
      DATA(lv_tc) = CONV ty_tx_build-entry_id( <ls_raw>-entry_id ).
      READ TABLE lt_build ASSIGNING FIELD-SYMBOL(<ls_build>)
        WITH TABLE KEY entry_id = lv_tc.
      IF sy-subrc <> 0.
        INSERT VALUE ty_tx_build(
            entry_id = lv_tc
            row = VALUE #( transaction_code = lv_tc
                           period_from = iv_from
                           period_to   = iv_to ) )
          INTO TABLE lt_build ASSIGNING <ls_build>.
      ENDIF.
      <ls_build>-row-execution_count   = <ls_build>-row-execution_count   + <ls_raw>-count.
      <ls_build>-row-dialog_step_count = <ls_build>-row-dialog_step_count + <ls_raw>-count.
      <ls_build>-row-total_resp_ms     = <ls_build>-row-total_resp_ms     + <ls_raw>-respti.
      <ls_build>-row-total_cpu_ms      = <ls_build>-row-total_cpu_ms      + <ls_raw>-cputi.
      <ls_build>-row-total_db_ms       = <ls_build>-row-total_db_ms       + <ls_raw>-dbti.
      INSERT CONV string( <ls_raw>-account ) INTO TABLE <ls_build>-users.
    ENDLOOP.

    LOOP AT lt_build ASSIGNING <ls_build>.
      <ls_build>-row-distinct_user_cnt = lines( <ls_build>-users ).
      IF <ls_build>-row-execution_count > 0.
        <ls_build>-row-avg_resp_ms =
          <ls_build>-row-total_resp_ms / <ls_build>-row-execution_count.
      ENDIF.
      APPEND <ls_build>-row TO et_tx_usage.
    ENDLOOP.
    SORT et_tx_usage BY execution_count DESCENDING transaction_code ASCENDING.

    " --- user x tcode rows, top-N per tcode, pseudonymised -------------------
    DATA lt_user_all TYPE ty_user_tx_t.
    LOOP AT lt_raw ASSIGNING <ls_raw>.
      APPEND VALUE ty_user_tx(
          user_key          = COND #(
            WHEN iv_pseudonymise = abap_true
            THEN zcl_ado_pseudonym=>hash( CONV string( <ls_raw>-account ) )
            ELSE <ls_raw>-account )
          transaction_code  = <ls_raw>-entry_id
          period_from       = iv_from
          period_to         = iv_to
          execution_count   = <ls_raw>-count
          dialog_step_count = <ls_raw>-count ) TO lt_user_all.
    ENDLOOP.
    SORT lt_user_all BY transaction_code ASCENDING execution_count DESCENDING.

    " Volume bound at the source: only the top-N users per transaction leave
    " the system (the SaaS proposal engine UNIONs user sets, it does not need
    " the long tail).
    DATA lv_current  TYPE ty_user_tx-transaction_code.
    DATA lv_taken    TYPE i.
    LOOP AT lt_user_all ASSIGNING FIELD-SYMBOL(<ls_user>).
      IF <ls_user>-transaction_code <> lv_current.
        lv_current = <ls_user>-transaction_code.
        lv_taken = 0.
      ENDIF.
      lv_taken = lv_taken + 1.
      IF lv_taken <= iv_top_users.
        APPEND <ls_user> TO et_user_tx.
      ENDIF.
    ENDLOOP.
    SORT et_user_tx BY transaction_code ASCENDING user_key ASCENDING.

    " Session cache (one window per extraction; OData pages re-enter here).
    IF lines( gt_cache ) >= 4.
      DELETE gt_cache INDEX 1.
    ENDIF.
    APPEND VALUE ty_cache( cache_key = lv_cache_key
                           tx_usage  = et_tx_usage
                           user_tx   = et_user_tx ) TO gt_cache.
  ENDMETHOD.

  METHOD month_starts.
    " lv_next must be TYPED d: date+integer arithmetic infers i, and an
    " integer does not permit the (6) substring below.
    DATA lv_next  TYPE d.
    DATA(lv_month) = CONV d( |{ iv_from(6) }01| ).
    WHILE lv_month <= iv_to.
      APPEND lv_month TO rt_months.
      " First day of the following month.
      lv_next  = CONV d( |{ lv_month(6) }28| ) + 5.
      lv_month = CONV d( |{ lv_next(6) }01| ).
      IF lines( rt_months ) > 36. "Hard cap: three years per window.
        EXIT.
      ENDIF.
    ENDWHILE.
  ENDMETHOD.

ENDCLASS.
