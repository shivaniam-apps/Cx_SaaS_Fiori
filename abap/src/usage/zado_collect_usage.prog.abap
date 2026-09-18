REPORT zado_collect_usage.

"---------------------------------------------------------------------
" AdoptOps usage snapshot collector (S7).
"
" Copies the ST03N USERTCODE aggregate month by month into the ZADO
" snapshot tables (ZADO_SNAP_USER, ZADO_SNAP_TX) so the SaaS reads
" persisted snapshots instead of calling the workload collector live.
" Schedule it in SM36 (job name ZADO_COLLECT_USAGE, variant with the
" defaults, monthly on the 2nd - the previous month is final by then;
" the current and previous month are always re-collected). Run it once
" by hand after installation to backfill the retention window.
"
" One month = one LUW: a re-run is idempotent, an aborted run leaves
" complete months only. ZADO_RUN keeps the run log, ZADO_AUDIT the
" events. Retention deletes months older than P_RETEN (0 = keep all).
"
" Read-only towards SAP: the report reads SWNC and writes ZADO_* only.
"---------------------------------------------------------------------

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_from FOR FIELD p_from.
PARAMETERS p_from TYPE d OBLIGATORY.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_to FOR FIELD p_to.
PARAMETERS p_to TYPE d OBLIGATORY.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_force FOR FIELD p_force.
PARAMETERS p_force AS CHECKBOX.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_reten FOR FIELD p_reten.
PARAMETERS p_reten TYPE i DEFAULT 36.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_from  = 'Period from'.
  c_to    = 'Period to'.
  c_force = 'Re-collect closed months'.
  c_reten = 'Retention (months, 0 = all)'.
  " Defaults: the configured collection window (ZADO_CFG COLLECT_MONTHS,
  " 13 when unset) up to today.
  p_to = sy-datum.
  DATA(lv_months) = zcl_ado_cfg=>collect_months( ).
  p_from = CONV d( |{ sy-datum(6) }01| ).
  DO lv_months - 1 TIMES.
    DATA(lv_prev) = CONV d( p_from - 1 ).
    p_from = CONV d( |{ lv_prev(6) }01| ).
  ENDDO.
  DATA(lv_reten) = zcl_ado_cfg=>snapshot_retention_months( ).
  IF lv_reten >= 0.
    p_reten = lv_reten.
  ENDIF.

START-OF-SELECTION.
  WRITE: / |System { sy-sysid } client { sy-mandt }: collecting { p_from } - { p_to }|.
  IF p_from > p_to.
    WRITE: / 'Period from is after period to - nothing done.'.
    RETURN.
  ENDIF.

  zcl_ado_collector=>collect_window(
    EXPORTING iv_from   = p_from
              iv_to     = p_to
              iv_force  = p_force
    IMPORTING es_run    = DATA(ls_run)
              et_months = DATA(lt_months) ).

  LOOP AT lt_months INTO DATA(ls_month).
    IF ls_month-skipped = abap_true.
      WRITE: / |  { ls_month-month(6) }: already snapshotted, skipped|.
    ELSE.
      WRITE: / |  { ls_month-month(6) }: { ls_month-user_rows } user x tcode rows, { ls_month-tx_rows } transactions|.
    ENDIF.
  ENDLOOP.

  WRITE: / |Run { ls_run-run_id }: { ls_run-status } - { ls_run-message }|.
  WRITE: / |  { ls_run-user_rows } user x tcode rows, { ls_run-tx_rows } transaction rows written|.

  IF ls_run-status = 'DONE' AND p_reten > 0.
    DATA(lv_deleted) = zcl_ado_collector=>apply_retention( p_reten ).
    WRITE: / |Retention { p_reten } months: { lv_deleted } month(s) deleted|.
  ENDIF.

  DATA(ls_coverage) = zcl_ado_snap_reader=>coverage( ).
  IF ls_coverage-months > 0.
    WRITE: / |Snapshot coverage: { ls_coverage-period_from } - { ls_coverage-period_to } ({ ls_coverage-months } month(s))|.
  ELSE.
    WRITE: / 'Snapshot coverage: none (no ST03N data in the window?)'.
  ENDIF.
