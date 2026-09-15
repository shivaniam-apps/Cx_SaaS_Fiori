CLASS zcl_ado_act_tasklist DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " STC01 task-list session driver. Lifecycle confirmed on RD1
    " (docu/06-s4-integration/api-matrix.md): STC_TM_SESSION_BEGIN is
    " the whole execution story (I_INIT_ONLY separates create from
    " run); STC_TM_SESSION_GET_STATUS is the polling surface;
    " STC_TM_SESSION_RESUME continues after manual intervention.
    " STC_TM_SESSION_START / STC_TM_TASKLIST_EXECUTE do NOT exist.
    "
    " Scenario names verified in the RD1 inventory (183 scenarios),
    " e.g. SAP_FIORI_FOUNDATION_S4, SAP_GATEWAY_ACTIVATE_ODATA_SERV.
    "
    " NOTE: parameter DDIC type names (session id, status structure)
    " were not captured by the probes - the locals below use the
    " standard STC types and MUST be validated by the first DEV syntax
    " check; each FM call is isolated for one-site correction.
    "---------------------------------------------------------------

    TYPES: BEGIN OF ty_session_status,
             status             TYPE c LENGTH 1,   " R running, F finished, E error, A action required
             progress           TYPE i,
             finished           TYPE abap_bool,
             failed             TYPE abap_bool,
             needs_intervention TYPE abap_bool,
           END OF ty_session_status.

    " Create + start a session for a scenario. The returned session id
    " is persisted on the CAP side (ActivationStepMessages RawJson) so
    " polling and resume survive process restarts.
    CLASS-METHODS begin
      IMPORTING iv_scenario      TYPE string
                iv_init_only     TYPE abap_bool DEFAULT abap_false
      EXPORTING ev_session_id    TYPE string
                es_result        TYPE zif_ado_act_step=>ty_result.

    CLASS-METHODS get_status
      IMPORTING iv_session_id    TYPE string
      RETURNING VALUE(rs_status) TYPE ty_session_status.

    CLASS-METHODS resume
      IMPORTING iv_session_id    TYPE string
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

ENDCLASS.


CLASS zcl_ado_act_tasklist IMPLEMENTATION.

  METHOD begin.
    CLEAR: ev_session_id, es_result.

    DATA lv_scenario   TYPE stc_scenario_id.
    DATA lv_init_only  TYPE abap_bool.
    DATA lv_session_id TYPE stc_session_id.
    lv_scenario  = iv_scenario.
    lv_init_only = iv_init_only.

    CALL FUNCTION 'STC_TM_SESSION_BEGIN'
      EXPORTING
        i_scenario_id = lv_scenario
        i_init_only   = lv_init_only
      IMPORTING
        e_session_id  = lv_session_id
      EXCEPTIONS
        OTHERS        = 1.
    IF sy-subrc <> 0 OR lv_session_id IS INITIAL.
      es_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |STC_TM_SESSION_BEGIN failed for scenario { iv_scenario } (subrc { sy-subrc }).| )
        TO es_result-messages.
      RETURN.
    ENDIF.

    ev_session_id    = lv_session_id.
    es_result-status = zif_ado_act_step=>c_status-success.
    APPEND VALUE bapiret2(
        type    = 'S'
        message = |Task-list session { ev_session_id } { COND #( WHEN iv_init_only = abap_true THEN 'created' ELSE 'started' ) } for { iv_scenario }.| )
      TO es_result-messages.
  ENDMETHOD.

  METHOD get_status.
    DATA lv_session_id TYPE stc_session_id.
    DATA lv_status     TYPE c LENGTH 1.
    DATA lv_progress   TYPE i.
    DATA lv_resume     TYPE abap_bool.
    lv_session_id = iv_session_id.

    CALL FUNCTION 'STC_TM_SESSION_GET_STATUS'
      EXPORTING
        i_session_id    = lv_session_id
      IMPORTING
        e_status        = lv_status
        e_progress      = lv_progress
        e_action_resume = lv_resume
      EXCEPTIONS
        OTHERS          = 1.
    IF sy-subrc <> 0.
      rs_status-failed = abap_true.
      RETURN.
    ENDIF.

    rs_status-status             = lv_status.
    rs_status-progress           = lv_progress.
    rs_status-finished           = xsdbool( lv_status = 'F' ).
    rs_status-failed             = xsdbool( lv_status = 'E' ).
    rs_status-needs_intervention = lv_resume.
  ENDMETHOD.

  METHOD resume.
    DATA lv_session_id TYPE stc_session_id.
    lv_session_id = iv_session_id.

    CALL FUNCTION 'STC_TM_SESSION_RESUME'
      EXPORTING
        i_session_id = lv_session_id
      EXCEPTIONS
        OTHERS       = 1.
    IF sy-subrc <> 0.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |STC_TM_SESSION_RESUME failed for session { iv_session_id } (subrc { sy-subrc }).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    rs_result-status = zif_ado_act_step=>c_status-success.
    APPEND VALUE bapiret2(
        type    = 'S'
        message = |Task-list session { iv_session_id } resumed.| )
      TO rs_result-messages.
  ENDMETHOD.

ENDCLASS.
