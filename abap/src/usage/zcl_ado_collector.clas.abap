CLASS zcl_ado_collector DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Usage snapshot collector (S7). Copies the ST03N USERTCODE
    " aggregate month by month into ZADO_SNAP_USER / ZADO_SNAP_TX so
    " the SaaS reads persisted snapshots instead of calling SWNC in the
    " request path (PROD-scale windows). One month = one LUW: delete +
    " insert + COMMIT, so a re-run is idempotent and an aborted run
    " leaves complete months only. Scheduled via ZADO_COLLECT_USAGE
    " (SM36, monthly), see docu/07 snapshot-collector.
    "
    " User ids are stored as ST03N stores them (real ids, inside the
    " customer's system); pseudonymisation happens at read time with
    " the tenant salt, exactly like the live reader (docu/11).
    "---------------------------------------------------------------
    CONSTANTS gc_run_type TYPE zado_run-run_type VALUE 'COLLECT'.
    " The current and the previous month are always re-collected: the
    " ST03N monthly aggregate keeps growing until the month closed.
    CONSTANTS gc_open_months TYPE i VALUE 2.

    TYPES: BEGIN OF ty_month_result,
             month     TYPE d,
             skipped   TYPE abap_bool,
             tx_rows   TYPE i,
             user_rows TYPE i,
           END OF ty_month_result,
           ty_month_results TYPE STANDARD TABLE OF ty_month_result WITH EMPTY KEY.

    " Collects every month of the window; months already snapshotted are
    " skipped unless iv_force or they are among the open months.
    CLASS-METHODS collect_window
      IMPORTING iv_from    TYPE d
                iv_to      TYPE d
                iv_force   TYPE abap_bool DEFAULT abap_false
      EXPORTING es_run     TYPE zado_run
                et_months  TYPE ty_month_results.

    " One month: delete + insert + commit. Public for the smoke report.
    CLASS-METHODS collect_month
      IMPORTING iv_month         TYPE d
                iv_run_id        TYPE zado_run-run_id
      RETURNING VALUE(rs_result) TYPE ty_month_result.

    " Deletes snapshot months older than iv_months (0 = keep everything).
    CLASS-METHODS apply_retention
      IMPORTING iv_months         TYPE i
      RETURNING VALUE(rv_deleted) TYPE i.

  PRIVATE SECTION.
    CLASS-METHODS new_run_id
      RETURNING VALUE(rv_id) TYPE zado_run-run_id.

    " First day of the month iv_back months before the current one.
    CLASS-METHODS months_back
      IMPORTING iv_back         TYPE i
      RETURNING VALUE(rv_first) TYPE d.
ENDCLASS.


CLASS zcl_ado_collector IMPLEMENTATION.

  METHOD new_run_id.
    TRY.
        rv_id = cl_system_uuid=>create_uuid_c32_static( ).
      CATCH cx_uuid_error.
        DATA lv_now TYPE timestampl.
        GET TIME STAMP FIELD lv_now.
        rv_id = |{ lv_now }|.
    ENDTRY.
  ENDMETHOD.

  METHOD months_back.
    DATA lv_prev TYPE d.
    rv_first = CONV d( |{ sy-datum(6) }01| ).
    DO iv_back TIMES.
      lv_prev  = rv_first - 1.
      rv_first = CONV d( |{ lv_prev(6) }01| ).
    ENDDO.
  ENDMETHOD.

  METHOD collect_month.
    rs_result-month = iv_month.

    DATA lt_raw TYPE zcl_ado_st03_reader=>ty_raw_t.
    zcl_ado_st03_reader=>read_month_raw(
      EXPORTING iv_month = iv_month
      CHANGING  ct_raw   = lt_raw ).

    DATA lv_now TYPE timestampl.
    GET TIME STAMP FIELD lv_now.

    " Per-month transaction rollup (distinct users within the month).
    TYPES: BEGIN OF ty_tx_build,
             entry_id TYPE zado_snap_tx-entry_id,
             row      TYPE zado_snap_tx,
             users    TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line,
           END OF ty_tx_build.
    DATA lt_build TYPE HASHED TABLE OF ty_tx_build WITH UNIQUE KEY entry_id.
    DATA lt_user  TYPE STANDARD TABLE OF zado_snap_user WITH EMPTY KEY.
    DATA lt_tx    TYPE STANDARD TABLE OF zado_snap_tx WITH EMPTY KEY.

    LOOP AT lt_raw ASSIGNING FIELD-SYMBOL(<ls_raw>).
      APPEND VALUE zado_snap_user(
        period_type  = zcl_ado_snap_reader=>gc_period_type
        period_start = iv_month
        account      = <ls_raw>-account
        entry_id     = <ls_raw>-entry_id
        exec_count   = <ls_raw>-count
        step_count   = <ls_raw>-count
        resp_ms      = <ls_raw>-respti
        cpu_ms       = <ls_raw>-cputi
        db_ms        = <ls_raw>-dbti
        collected_at = lv_now
        run_id       = iv_run_id ) TO lt_user.

      READ TABLE lt_build ASSIGNING FIELD-SYMBOL(<ls_build>)
        WITH TABLE KEY entry_id = <ls_raw>-entry_id.
      IF sy-subrc <> 0.
        INSERT VALUE ty_tx_build(
            entry_id = <ls_raw>-entry_id
            row = VALUE #( period_type  = zcl_ado_snap_reader=>gc_period_type
                           period_start = iv_month
                           entry_id     = <ls_raw>-entry_id
                           collected_at = lv_now
                           run_id       = iv_run_id ) )
          INTO TABLE lt_build ASSIGNING <ls_build>.
      ENDIF.
      <ls_build>-row-exec_count = <ls_build>-row-exec_count + <ls_raw>-count.
      <ls_build>-row-step_count = <ls_build>-row-step_count + <ls_raw>-count.
      <ls_build>-row-resp_ms    = <ls_build>-row-resp_ms    + <ls_raw>-respti.
      <ls_build>-row-cpu_ms     = <ls_build>-row-cpu_ms     + <ls_raw>-cputi.
      <ls_build>-row-db_ms      = <ls_build>-row-db_ms      + <ls_raw>-dbti.
      INSERT CONV string( <ls_raw>-account ) INTO TABLE <ls_build>-users.
    ENDLOOP.
    LOOP AT lt_build ASSIGNING <ls_build>.
      <ls_build>-row-distinct_users = lines( <ls_build>-users ).
      APPEND <ls_build>-row TO lt_tx.
    ENDLOOP.

    " One LUW per month: a month is either complete or absent.
    DELETE FROM zado_snap_user
      WHERE period_type = @zcl_ado_snap_reader=>gc_period_type AND period_start = @iv_month.
    DELETE FROM zado_snap_tx
      WHERE period_type = @zcl_ado_snap_reader=>gc_period_type AND period_start = @iv_month.
    IF lt_user IS NOT INITIAL.
      INSERT zado_snap_user FROM TABLE @lt_user.
      INSERT zado_snap_tx   FROM TABLE @lt_tx.
    ENDIF.
    COMMIT WORK.

    rs_result-user_rows = lines( lt_user ).
    rs_result-tx_rows   = lines( lt_tx ).
  ENDMETHOD.

  METHOD collect_window.
    CLEAR: es_run, et_months.
    DATA lv_now TYPE timestampl.
    GET TIME STAMP FIELD lv_now.

    es_run = VALUE zado_run(
      run_id      = new_run_id( )
      run_type    = gc_run_type
      period_type = zcl_ado_snap_reader=>gc_period_type
      period_from = iv_from
      period_to   = iv_to
      status      = 'RUNNING'
      started_at  = lv_now
      started_by  = sy-uname ).
    INSERT zado_run FROM @es_run.
    zcl_ado_audit=>log( iv_type = zcl_ado_audit=>gc_collect_started
                        iv_object = es_run-run_id
                        iv_message = |{ iv_from } - { iv_to }, force { iv_force }| ).
    COMMIT WORK.

    DATA(lt_months) = zcl_ado_st03_reader=>month_starts( iv_from = iv_from iv_to = iv_to ).
    " Months already snapshotted (closed ones are skipped without force).
    DATA lt_r_month TYPE RANGE OF d.
    LOOP AT lt_months INTO DATA(lv_month).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_month ) TO lt_r_month.
    ENDLOOP.
    DATA lt_present TYPE SORTED TABLE OF d WITH UNIQUE KEY table_line.
    IF lt_r_month IS NOT INITIAL.
      SELECT DISTINCT period_start FROM zado_snap_tx
        WHERE period_type = @zcl_ado_snap_reader=>gc_period_type
          AND period_start IN @lt_r_month
        INTO TABLE @lt_present.
    ENDIF.
    DATA(lv_open_from) = months_back( gc_open_months - 1 ).

    TRY.
        LOOP AT lt_months INTO lv_month.
          READ TABLE lt_present TRANSPORTING NO FIELDS WITH TABLE KEY table_line = lv_month.
          IF sy-subrc = 0 AND iv_force = abap_false AND lv_month < lv_open_from.
            APPEND VALUE ty_month_result( month = lv_month skipped = abap_true ) TO et_months.
            es_run-months_skipped = es_run-months_skipped + 1.
            CONTINUE.
          ENDIF.
          DATA(ls_result) = collect_month( iv_month = lv_month iv_run_id = es_run-run_id ).
          APPEND ls_result TO et_months.
          es_run-months_done = es_run-months_done + 1.
          es_run-tx_rows     = es_run-tx_rows   + ls_result-tx_rows.
          es_run-user_rows   = es_run-user_rows + ls_result-user_rows.
        ENDLOOP.
        es_run-status  = 'DONE'.
        es_run-message = |{ es_run-months_done } month(s) collected, { es_run-months_skipped } skipped|.
      CATCH cx_root INTO DATA(lx_error).
        es_run-status  = 'FAILED'.
        es_run-message = lx_error->get_text( ).
    ENDTRY.

    GET TIME STAMP FIELD es_run-finished_at.
    UPDATE zado_run FROM @es_run.
    zcl_ado_audit=>log(
      iv_type    = COND #( WHEN es_run-status = 'DONE' THEN zcl_ado_audit=>gc_collect_done ELSE zcl_ado_audit=>gc_collect_failed )
      iv_object  = es_run-run_id
      iv_message = es_run-message ).
    COMMIT WORK.
  ENDMETHOD.

  METHOD apply_retention.
    IF iv_months <= 0.
      RETURN.
    ENDIF.
    " First day of the oldest month to keep.
    DATA(lv_keep_from) = months_back( iv_months - 1 ).
    SELECT COUNT( DISTINCT period_start ) FROM zado_snap_tx
      WHERE period_type = @zcl_ado_snap_reader=>gc_period_type
        AND period_start < @lv_keep_from
      INTO @rv_deleted.
    IF rv_deleted = 0.
      RETURN.
    ENDIF.
    DELETE FROM zado_snap_user
      WHERE period_type = @zcl_ado_snap_reader=>gc_period_type AND period_start < @lv_keep_from.
    DELETE FROM zado_snap_tx
      WHERE period_type = @zcl_ado_snap_reader=>gc_period_type AND period_start < @lv_keep_from.
    zcl_ado_audit=>log( iv_type = zcl_ado_audit=>gc_retention
                        iv_object = |{ lv_keep_from }|
                        iv_message = |{ rv_deleted } month(s) older than { lv_keep_from } deleted| ).
    COMMIT WORK.
  ENDMETHOD.

ENDCLASS.
