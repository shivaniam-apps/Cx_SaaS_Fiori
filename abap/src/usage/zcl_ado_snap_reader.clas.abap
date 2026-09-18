CLASS zcl_ado_snap_reader DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Reads the usage window from the ZADO_SNAP_* tables written by
    " ZCL_ADO_COLLECTOR (S7) instead of calling SWNC live. Same output
    " contract as ZCL_ADO_ST03_READER=>GET_WINDOW, so the query
    " providers pick the source per request (SNAPSHOT when the window
    " is covered, else LIVE).
    "
    " The transaction rollup is computed AT THE DATABASE (GROUP BY over
    " the window's months, distinct users via COUNT DISTINCT), which is
    " what makes PROD-scale windows cheap. User x tcode rows are grouped
    " at the database too; the threshold is a HAVING clause, so only
    " users above it reach ABAP, where the top-N cut and the
    " pseudonymisation happen exactly as in the live reader.
    "---------------------------------------------------------------
    CONSTANTS gc_period_type TYPE zado_snap_tx-period_type VALUE 'M'.

    TYPES: BEGIN OF ty_coverage,
             period_from  TYPE d,   "first snapshotted month start
             period_to    TYPE d,   "last day of the last snapshotted month
             months       TYPE i,
             collected_at TYPE timestampl,
           END OF ty_coverage.

    " abap_true when every month start of the window has snapshot rows.
    CLASS-METHODS covers
      IMPORTING iv_from           TYPE d
                iv_to             TYPE d
      RETURNING VALUE(rv_covered) TYPE abap_bool.

    CLASS-METHODS coverage
      RETURNING VALUE(rs_coverage) TYPE ty_coverage.

    CLASS-METHODS get_window
      IMPORTING iv_from           TYPE d
                iv_to             TYPE d
                iv_pseudonymise   TYPE abap_bool DEFAULT abap_true
                iv_top_users      TYPE i DEFAULT 20
                iv_min_executions TYPE i DEFAULT 1
                iv_tenant         TYPE string OPTIONAL
      EXPORTING et_tx_usage       TYPE zcl_ado_st03_reader=>ty_tx_usage_t
                et_user_tx        TYPE zcl_ado_st03_reader=>ty_user_tx_t.

  PRIVATE SECTION.
    TYPES ty_date_t TYPE STANDARD TABLE OF d WITH EMPTY KEY.

    CLASS-METHODS snapshotted_months
      IMPORTING it_months        TYPE ty_date_t
      RETURNING VALUE(rt_months) TYPE ty_date_t.
ENDCLASS.


CLASS zcl_ado_snap_reader IMPLEMENTATION.

  METHOD snapshotted_months.
    IF it_months IS INITIAL.
      RETURN.
    ENDIF.
    DATA lt_r_month TYPE RANGE OF d.
    LOOP AT it_months INTO DATA(lv_month).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_month ) TO lt_r_month.
    ENDLOOP.
    SELECT DISTINCT period_start FROM zado_snap_tx
      WHERE period_type = @gc_period_type
        AND period_start IN @lt_r_month
      ORDER BY period_start
      INTO TABLE @rt_months.
  ENDMETHOD.

  METHOD covers.
    DATA(lt_months) = zcl_ado_st03_reader=>month_starts( iv_from = iv_from iv_to = iv_to ).
    rv_covered = xsdbool( lt_months IS NOT INITIAL
                      AND lines( snapshotted_months( lt_months ) ) = lines( lt_months ) ).
  ENDMETHOD.

  METHOD coverage.
    SELECT MIN( period_start ) AS period_from,
           MAX( period_start ) AS period_to,
           COUNT( DISTINCT period_start ) AS months,
           MAX( collected_at ) AS collected_at
      FROM zado_snap_tx
      WHERE period_type = @gc_period_type
      INTO CORRESPONDING FIELDS OF @rs_coverage.
    IF rs_coverage-months > 0.
      " Last day of the last month: first of the following month minus one.
      DATA(lv_next) = CONV d( |{ rs_coverage-period_to(6) }28| ) + 5.
      rs_coverage-period_to = CONV d( |{ lv_next(6) }01| ) - 1.
    ELSE.
      CLEAR rs_coverage.
    ENDIF.
  ENDMETHOD.

  METHOD get_window.
    CLEAR: et_tx_usage, et_user_tx.
    DATA(lt_months) = zcl_ado_st03_reader=>month_starts( iv_from = iv_from iv_to = iv_to ).
    IF lt_months IS INITIAL.
      RETURN.
    ENDIF.
    DATA lt_r_month TYPE RANGE OF d.
    LOOP AT lt_months INTO DATA(lv_month).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_month ) TO lt_r_month.
    ENDLOOP.

    " --- transactions: one GROUP BY at the database ------------------------
    SELECT entry_id,
           SUM( exec_count )        AS exec_count,
           SUM( step_count )        AS step_count,
           COUNT( DISTINCT account ) AS distinct_users,
           SUM( resp_ms )           AS resp_ms,
           SUM( cpu_ms )            AS cpu_ms,
           SUM( db_ms )             AS db_ms
      FROM zado_snap_user
      WHERE period_type = @gc_period_type
        AND period_start IN @lt_r_month
      GROUP BY entry_id
      INTO TABLE @DATA(lt_tx).

    LOOP AT lt_tx ASSIGNING FIELD-SYMBOL(<ls_tx>).
      DATA(ls_row) = VALUE zcl_ado_st03_reader=>ty_tx_usage(
        transaction_code  = <ls_tx>-entry_id
        period_from       = iv_from
        period_to         = iv_to
        execution_count   = <ls_tx>-exec_count
        dialog_step_count = <ls_tx>-step_count
        distinct_user_cnt = <ls_tx>-distinct_users
        total_resp_ms     = <ls_tx>-resp_ms
        total_cpu_ms      = <ls_tx>-cpu_ms
        total_db_ms       = <ls_tx>-db_ms ).
      IF ls_row-execution_count > 0.
        ls_row-avg_resp_ms = ls_row-total_resp_ms / ls_row-execution_count.
      ENDIF.
      APPEND ls_row TO et_tx_usage.
    ENDLOOP.
    SORT et_tx_usage BY execution_count DESCENDING transaction_code ASCENDING.

    " --- user x tcode: grouped at the database, threshold in HAVING ---------
    DATA(lv_min) = COND i( WHEN iv_min_executions > 1 THEN iv_min_executions ELSE 1 ).
    SELECT account, entry_id,
           SUM( exec_count ) AS exec_count,
           SUM( step_count ) AS step_count
      FROM zado_snap_user
      WHERE period_type = @gc_period_type
        AND period_start IN @lt_r_month
      GROUP BY account, entry_id
      HAVING SUM( exec_count ) >= @lv_min
      ORDER BY entry_id ASCENDING, exec_count DESCENDING, account ASCENDING
      INTO TABLE @DATA(lt_users).

    " Top-N per transaction, then pseudonymise only the rows that leave.
    DATA lv_current TYPE zado_snap_user-entry_id.
    DATA lv_taken   TYPE i.
    LOOP AT lt_users ASSIGNING FIELD-SYMBOL(<ls_user>).
      IF <ls_user>-entry_id <> lv_current.
        lv_current = <ls_user>-entry_id.
        lv_taken = 0.
      ENDIF.
      lv_taken = lv_taken + 1.
      IF iv_top_users > 0 AND lv_taken > iv_top_users.
        CONTINUE.
      ENDIF.
      APPEND VALUE zcl_ado_st03_reader=>ty_user_tx(
        user_key          = COND string(
                              WHEN iv_pseudonymise = abap_true
                              THEN zcl_ado_pseudonym=>hash( iv_value = CONV string( <ls_user>-account ) iv_tenant = iv_tenant )
                              ELSE <ls_user>-account )
        transaction_code  = <ls_user>-entry_id
        period_from       = iv_from
        period_to         = iv_to
        execution_count   = <ls_user>-exec_count
        dialog_step_count = <ls_user>-step_count ) TO et_user_tx.
    ENDLOOP.
    SORT et_user_tx BY transaction_code ASCENDING user_key ASCENDING.
  ENDMETHOD.

ENDCLASS.
