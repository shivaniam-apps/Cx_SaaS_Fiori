CLASS zcl_ado_act_icf DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " ICF node activation (write). Verify-first and verify-after via
    " the ICF_NOACT flag read straight from ICFSERVICE - column
    " confirmed on RD1 (docu/06-s4-integration/api-matrix.md,
    " headline 5).
    "
    " IRREVERSIBLE on this release: the HTTP_DEACTIVATE_NODE* family
    " does not exist on A4H or RD1; only HTTP_ACTIVATE_NODE is
    " available. Rollback of an ICF step is therefore recorded in the
    " audit trail, never performed (an active-but-unused node is
    " harmless). Deactivation via CL_ICF_TREE remains an open manual
    " check (api-matrix "still manual" item 5).
    "---------------------------------------------------------------

    " Active means: the name exists and no node carrying it is
    " flagged inactive. A service name can appear on several nodes,
    " so the conservative reading is all-of-them.
    CLASS-METHODS is_node_active
      IMPORTING iv_icf_name      TYPE icfname
      RETURNING VALUE(rv_active) TYPE abap_bool.

    CLASS-METHODS activate
      IMPORTING iv_url           TYPE string
                iv_icf_name      TYPE icfname
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

ENDCLASS.


CLASS zcl_ado_act_icf IMPLEMENTATION.

  METHOD is_node_active.
    SELECT COUNT(*) FROM icfservice
      WHERE icf_name = @iv_icf_name
      INTO @DATA(lv_total).
    SELECT COUNT(*) FROM icfservice
      WHERE icf_name  = @iv_icf_name
        AND icf_noact = @abap_true
      INTO @DATA(lv_inactive).
    rv_active = xsdbool( lv_total > 0 AND lv_inactive = 0 ).
  ENDMETHOD.

  METHOD activate.
    IF is_node_active( iv_icf_name ) = abap_true.
      rs_result-status         = zif_ado_act_step=>c_status-skipped.
      rs_result-exists_already = abap_true.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |ICF node { iv_icf_name } is already active - step skipped (idempotent).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    " Typed variable, not a literal (CALL_FUNCTION_CONFLICT_TYPE lesson
    " from the SWNC reader on RD1).
    DATA lv_url TYPE string.
    lv_url = iv_url.
    CALL FUNCTION 'HTTP_ACTIVATE_NODE'
      EXPORTING
        url    = lv_url
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc <> 0.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |HTTP_ACTIVATE_NODE failed for { iv_url } (subrc { sy-subrc }).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    " Verify-after: the inactive flag must be gone.
    IF is_node_active( iv_icf_name ) = abap_true.
      rs_result-status = zif_ado_act_step=>c_status-warning.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |ICF node { iv_icf_name } activated and verified.| )
        TO rs_result-messages.
      APPEND VALUE bapiret2(
          type    = 'W'
          message = |Irreversible: ICF deactivation is not available on this release; rollback is audit-only.| )
        TO rs_result-messages.
    ELSE.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |Post-verification failed: { iv_icf_name } still carries inactive nodes after activation.| )
        TO rs_result-messages.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
