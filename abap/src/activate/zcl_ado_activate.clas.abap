CLASS zcl_ado_activate DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Step dispatcher of the AdoptOps activation write unit.
    "
    " Contract with the CAP execution engine:
    " - iv_step_type / iv_object_key_json mirror ActivationSteps
    "   (StepType, ObjectKeyJson) persisted by the SaaS planner.
    " - ONE database LUW per step: COMMIT WORK on SUCCESS / WARNING /
    "   SKIPPED, ROLLBACK WORK on FAILED. Never more than one step per
    "   call, never a plan-wide LUW.
    " - Verify-first lives in the executors: repeating a completed
    "   step yields SKIPPED + exists_already, so execution RESUMES,
    "   it never blindly retries.
    "
    " SAFETY: this class ships to DEV only; the write service binding
    " stays unpublished in QA/PROD (CLAUDE.md safety contract).
    "
    " Not yet dispatchable (returns FAILED with an explicit message):
    " ACTIVATE_ODATA_SERVICE (needs the SAP_GATEWAY_ACTIVATE_ODATA_SERV
    " parameter shape - open check), CREATE_SPACE / CREATE_PAGE /
    " ASSIGN_PAGE_TO_SPACE (FDM_*_SRV write path - open check 4),
    " ASSIGN_BUSINESS_CATALOG / ADD_CATALOG_TO_ROLE / ADD_SPACE_TO_ROLE
    " (AGR_HIER node shape - open check 2).
    "---------------------------------------------------------------

    " Key shapes deserialized from ObjectKeyJson (camelCase on the
    " wire, /ui2/cl_json maps to these fields).
    TYPES: BEGIN OF ty_tasklist_key,
             scenario TYPE string,
           END OF ty_tasklist_key.
    TYPES: BEGIN OF ty_icf_key,
             url      TYPE string,
             icf_name TYPE string,
           END OF ty_icf_key.
    TYPES: BEGIN OF ty_role_key,
             role  TYPE string,
             text  TYPE string,
             users TYPE string_table,
           END OF ty_role_key.
    TYPES: BEGIN OF ty_transport_key,
             text       TYPE string,
             trkorr     TYPE string,
             simulation TYPE abap_bool,
           END OF ty_transport_key.

    CLASS-METHODS execute_step
      IMPORTING iv_step_type       TYPE string
                iv_object_key_json TYPE string
      RETURNING VALUE(rs_result)   TYPE zif_ado_act_step=>ty_result.

  PRIVATE SECTION.
    CLASS-METHODS not_implemented
      IMPORTING iv_step_type     TYPE string
                iv_reason        TYPE string
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

ENDCLASS.


CLASS zcl_ado_activate IMPLEMENTATION.

  METHOD execute_step.
    CASE iv_step_type.

      WHEN 'RUN_TASK_LIST'.
        DATA ls_tasklist TYPE ty_tasklist_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_tasklist ).
        zcl_ado_act_tasklist=>begin(
          EXPORTING iv_scenario = ls_tasklist-scenario
          IMPORTING es_result   = rs_result ).

      WHEN 'ACTIVATE_ICF_NODE'.
        DATA ls_icf TYPE ty_icf_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_icf ).
        rs_result = zcl_ado_act_icf=>activate(
          iv_url      = ls_icf-url
          iv_icf_name = CONV #( ls_icf-icf_name ) ).

      WHEN 'CREATE_PFCG_ROLE'.
        DATA ls_role TYPE ty_role_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_role ).
        rs_result = zcl_ado_act_role=>create_role(
          iv_role = CONV #( ls_role-role )
          iv_text = ls_role-text ).

      WHEN 'GENERATE_PROFILE'.
        DATA ls_profile TYPE ty_role_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_profile ).
        rs_result = zcl_ado_act_role=>generate_profile(
          iv_role = CONV #( ls_profile-role ) ).

      WHEN 'ASSIGN_ROLE_TO_USERS'.
        DATA ls_assign TYPE ty_role_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_assign ).
        rs_result = zcl_ado_act_role=>assign_users(
          iv_role  = CONV #( ls_assign-role )
          it_users = ls_assign-users ).

      WHEN 'ADD_TO_TRANSPORT'.
        DATA ls_transport TYPE ty_transport_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_transport ).
        IF ls_transport-trkorr IS INITIAL.
          rs_result = zcl_ado_act_cts=>create_request(
            iv_text = CONV #( ls_transport-text ) ).
        ELSE.
          rs_result = zcl_ado_act_cts=>release_request(
            iv_trkorr     = CONV #( ls_transport-trkorr )
            iv_simulation = ls_transport-simulation ).
        ENDIF.

      WHEN 'ACTIVATE_ODATA_SERVICE'.
        rs_result = not_implemented(
          iv_step_type = iv_step_type
          iv_reason    = 'SAP_GATEWAY_ACTIVATE_ODATA_SERV parameter shape not yet captured (run STC_TM_SCENARIO_GET_PARAMETERS on RD1).' ).

      WHEN 'CREATE_SPACE' OR 'CREATE_PAGE' OR 'ASSIGN_PAGE_TO_SPACE'.
        rs_result = not_implemented(
          iv_step_type = iv_step_type
          iv_reason    = 'Spaces/pages write path pending FDM_*_SRV activation-state check (api-matrix open item 4).' ).

      WHEN 'ASSIGN_BUSINESS_CATALOG' OR 'ADD_CATALOG_TO_ROLE' OR 'ADD_SPACE_TO_ROLE'.
        rs_result = not_implemented(
          iv_step_type = iv_step_type
          iv_reason    = 'AGR_HIER catalog/space node shape pending SE16 probe (api-matrix open item 2).' ).

      WHEN OTHERS.
        rs_result = not_implemented(
          iv_step_type = iv_step_type
          iv_reason    = 'Unknown step type.' ).
    ENDCASE.

    " One LUW per step - the only COMMIT/ROLLBACK in the write unit.
    IF rs_result-status = zif_ado_act_step=>c_status-failed.
      ROLLBACK WORK.
    ELSE.
      COMMIT WORK AND WAIT.
    ENDIF.
  ENDMETHOD.

  METHOD not_implemented.
    rs_result-status = zif_ado_act_step=>c_status-failed.
    APPEND VALUE bapiret2(
        type    = 'E'
        message = |Step type { iv_step_type } is not executable yet: { iv_reason }| )
      TO rs_result-messages.
  ENDMETHOD.

ENDCLASS.
