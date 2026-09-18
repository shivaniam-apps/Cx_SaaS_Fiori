CLASS zcl_ado_audit DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Append-only audit log of the add-on itself (ZADO_AUDIT, per
    " client, never transported): collector runs, configuration
    " changes. Rows are inserted without COMMIT - the caller's LUW
    " decides, so an aborted run never leaves an orphan "done" event.
    "---------------------------------------------------------------
    CONSTANTS:
      gc_collect_started TYPE zado_audit-event_type VALUE 'COLLECT_STARTED',
      gc_collect_done    TYPE zado_audit-event_type VALUE 'COLLECT_DONE',
      gc_collect_failed  TYPE zado_audit-event_type VALUE 'COLLECT_FAILED',
      gc_retention       TYPE zado_audit-event_type VALUE 'RETENTION_APPLIED',
      gc_cfg_changed     TYPE zado_audit-event_type VALUE 'CFG_CHANGED'.

    CLASS-METHODS log
      IMPORTING iv_type    TYPE zado_audit-event_type
                iv_object  TYPE csequence OPTIONAL
                iv_message TYPE csequence OPTIONAL.
ENDCLASS.


CLASS zcl_ado_audit IMPLEMENTATION.

  METHOD log.
    DATA lv_now TYPE timestampl.
    GET TIME STAMP FIELD lv_now.
    TRY.
        DATA(lv_id) = cl_system_uuid=>create_uuid_c32_static( ).
      CATCH cx_uuid_error.
        lv_id = |{ lv_now }|.
    ENDTRY.
    DATA(ls_row) = VALUE zado_audit(
      audit_id   = lv_id
      event_at   = lv_now
      event_type = iv_type
      actor      = sy-uname
      object_key = iv_object
      message    = iv_message ).
    INSERT zado_audit FROM @ls_row.
  ENDMETHOD.

ENDCLASS.
