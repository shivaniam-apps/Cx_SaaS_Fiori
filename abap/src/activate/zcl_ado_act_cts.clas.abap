CLASS zcl_ado_act_cts DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " CTS wrapper: create / append / release with simulation, plus a
    " status read for polling. FM family confirmed on A4H and RD1
    " (docu/06-s4-integration/api-matrix.md): TR_INSERT_NEW_COMM,
    " TR_APPEND_TO_COMM_OBJS_KEYS, TRINT_RELEASE_REQUEST (with
    " IV_SIMULATION), release progress polled via E070-TRSTATUS.
    "
    " Every FM call sits in exactly one method so a parameter-name
    " correction from the DEV syntax check is a one-site fix.
    "---------------------------------------------------------------

    " Workbench request ('K') owned by the calling (technical) user.
    CLASS-METHODS create_request
      IMPORTING iv_text          TYPE as4text
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

    CLASS-METHODS append_objects
      IMPORTING iv_trkorr        TYPE trkorr
                it_e071          TYPE tr_objects
                it_e071k         TYPE tr_keys
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

    " iv_simulation = abap_true runs the release checks without
    " releasing (TRINT IV_SIMULATION, confirmed present).
    CLASS-METHODS release_request
      IMPORTING iv_trkorr        TYPE trkorr
                iv_simulation    TYPE abap_bool DEFAULT abap_false
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

    " E070 status: D/L = modifiable, O = release started, R = released.
    CLASS-METHODS read_status
      IMPORTING iv_trkorr        TYPE trkorr
      RETURNING VALUE(rv_status) TYPE trstatus.

ENDCLASS.


CLASS zcl_ado_act_cts IMPLEMENTATION.

  METHOD create_request.
    DATA lv_text       TYPE as4text.
    DATA lv_trfunction TYPE trfunction.
    DATA lv_trkorr     TYPE trkorr.
    lv_text       = iv_text.
    lv_trfunction = 'K'.

    " Signature corrected after an RD1 ST22 (CALL_FUNCTION_PARM_UNKNOWN):
    " there is no WI_USER; user and client default to sy-uname/sy-mandt,
    " so neither is passed.
    CALL FUNCTION 'TR_INSERT_NEW_COMM'
      EXPORTING
        wi_kurztext   = lv_text
        wi_trfunction = lv_trfunction
      IMPORTING
        we_trkorr     = lv_trkorr
      EXCEPTIONS
        OTHERS        = 1.
    IF sy-subrc <> 0 OR lv_trkorr IS INITIAL.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |TR_INSERT_NEW_COMM failed (subrc { sy-subrc }).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    rs_result-status = zif_ado_act_step=>c_status-success.
    rs_result-trkorr = lv_trkorr.
    APPEND VALUE bapiret2(
        type    = 'S'
        message = |Transport request { lv_trkorr } created: { iv_text }| )
      TO rs_result-messages.
  ENDMETHOD.

  METHOD append_objects.
    DATA lt_e071  TYPE tr_objects.
    DATA lt_e071k TYPE tr_keys.
    lt_e071  = it_e071.
    lt_e071k = it_e071k.

    CALL FUNCTION 'TR_APPEND_TO_COMM_OBJS_KEYS'
      EXPORTING
        wi_trkorr = iv_trkorr
      TABLES
        wt_e071   = lt_e071
        wt_e071k  = lt_e071k
      EXCEPTIONS
        OTHERS    = 1.
    IF sy-subrc <> 0.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |TR_APPEND_TO_COMM_OBJS_KEYS failed for { iv_trkorr } (subrc { sy-subrc }).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    rs_result-status = zif_ado_act_step=>c_status-success.
    rs_result-trkorr = iv_trkorr.
    APPEND VALUE bapiret2(
        type    = 'S'
        message = |{ lines( lt_e071 ) } object(s), { lines( lt_e071k ) } key(s) appended to { iv_trkorr }.| )
      TO rs_result-messages.
  ENDMETHOD.

  METHOD release_request.
    " Idempotency: a released request stays released.
    IF read_status( iv_trkorr ) = 'R'.
      rs_result-status         = zif_ado_act_step=>c_status-skipped.
      rs_result-exists_already = abap_true.
      rs_result-trkorr         = iv_trkorr.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |{ iv_trkorr } is already released - step skipped.| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    DATA lv_simulation TYPE abap_bool.
    lv_simulation = iv_simulation.
    CALL FUNCTION 'TRINT_RELEASE_REQUEST'
      EXPORTING
        iv_trkorr            = iv_trkorr
        iv_dialog            = abap_false
        iv_as_background_job = abap_false
        iv_simulation        = lv_simulation
      EXCEPTIONS
        OTHERS               = 1.
    IF sy-subrc <> 0.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |TRINT_RELEASE_REQUEST failed for { iv_trkorr } (subrc { sy-subrc }, simulation { iv_simulation }).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    IF iv_simulation = abap_true.
      rs_result-status = zif_ado_act_step=>c_status-success.
      rs_result-trkorr = iv_trkorr.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |Release simulation for { iv_trkorr } passed - nothing released.| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    " Verify-after: release may complete asynchronously; O (release
    " started) counts as success for the step, the monitor polls
    " read_status( ) until R.
    DATA(lv_status) = read_status( iv_trkorr ).
    IF lv_status = 'R' OR lv_status = 'O'.
      rs_result-status = zif_ado_act_step=>c_status-success.
      rs_result-trkorr = iv_trkorr.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |{ iv_trkorr } release initiated (E070 status { lv_status }).| )
        TO rs_result-messages.
    ELSE.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |{ iv_trkorr } not released (E070 status { lv_status }).| )
        TO rs_result-messages.
    ENDIF.
  ENDMETHOD.

  METHOD read_status.
    SELECT SINGLE trstatus FROM e070
      WHERE trkorr = @iv_trkorr
      INTO @rv_status.
  ENDMETHOD.

ENDCLASS.
