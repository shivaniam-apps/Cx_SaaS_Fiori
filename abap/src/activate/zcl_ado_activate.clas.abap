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
    " ObjectKeyJson contract: the SaaS planner is the single source
    " (Cx_SaaS_Fiori code/srv/srv/utils/activation-plan.js, objectKey).
    " Its shapes are captured in code/test/fixtures/
    " activation-object-keys.json and explained in docu/09-activation-
    " and-transport/object-key-contract.md. The key types below mirror
    " that fixture field for field - snake_case here, camelCase on the
    " wire (/ui2/cl_json pretty_mode-camel_case) - and a CAP test parses
    " this source and fails when the two drift. A key that lacks what
    " its executor needs is refused with FAILED before any FM call.
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

    " One key type per dispatchable step type (field names = fixture).
    TYPES: BEGIN OF ty_tasklist_key,          " RUN_TASK_LIST
             scenario TYPE string,
           END OF ty_tasklist_key.
    TYPES: BEGIN OF ty_icf_key,               " ACTIVATE_ICF_NODE
             fiori_id TYPE string,
             url      TYPE string,
             icf_name TYPE string,
           END OF ty_icf_key.
    TYPES: BEGIN OF ty_role_key,              " CREATE_PFCG_ROLE
             role            TYPE string,
             text            TYPE string,
             reference_roles TYPE string_table,
             trkorr          TYPE string,     "   injected by the engine
           END OF ty_role_key.               "   from the plan's request
    TYPES: BEGIN OF ty_profile_key,           " GENERATE_PROFILE
             role TYPE string,
           END OF ty_profile_key.
    TYPES: BEGIN OF ty_assign_key,            " ASSIGN_ROLE_TO_USERS
             role  TYPE string,
             users TYPE string_table,
           END OF ty_assign_key.
    TYPES: BEGIN OF ty_transport_key,         " ADD_TO_TRANSPORT
             text       TYPE string,          "   { text }  -> create
             trkorr     TYPE string,          "   { trkorr, simulation }
             simulation TYPE abap_bool,       "             -> release
           END OF ty_transport_key.
    " One E071-shaped object reference: { pgmid, object, objName }.
    TYPES: BEGIN OF ty_append_object,
             pgmid    TYPE string,
             object   TYPE string,
             obj_name TYPE string,
           END OF ty_append_object.
    TYPES ty_append_objects TYPE STANDARD TABLE OF ty_append_object WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_append_key,            " APPEND_TO_TRANSPORT
             trkorr  TYPE string,             "   injected by the engine
             objects TYPE ty_append_objects,
           END OF ty_append_key.

    CLASS-METHODS execute_step
      IMPORTING iv_step_type       TYPE string
                iv_object_key_json TYPE string
      RETURNING VALUE(rs_result)   TYPE zif_ado_act_step=>ty_result.

  PRIVATE SECTION.
    CLASS-METHODS not_implemented
      IMPORTING iv_step_type     TYPE string
                iv_reason        TYPE string
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

    " Contract violation: the key does not carry what the executor
    " needs. Reported as FAILED (never dumps), naming the missing field.
    CLASS-METHODS incomplete_key
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
        IF ls_tasklist-scenario IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'scenario is empty.' ).
        ELSE.
          zcl_ado_act_tasklist=>begin(
            EXPORTING iv_scenario = ls_tasklist-scenario
            IMPORTING es_result   = rs_result ).
        ENDIF.

      WHEN 'ACTIVATE_ICF_NODE'.
        DATA ls_icf TYPE ty_icf_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_icf ).
        " The planner fills url/icfName from the catalog's BSP application
        " (BackendCatalogApps); an app without a catalog row arrives with
        " both empty and must never reach HTTP_ACTIVATE_NODE.
        IF ls_icf-url IS INITIAL OR ls_icf-icf_name IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = |url/icfName are empty for app { ls_icf-fiori_id } - | &&
                           |run catalog derivation so the BSP application is known.| ).
        ELSE.
          rs_result = zcl_ado_act_icf=>activate(
            iv_url      = ls_icf-url
            iv_icf_name = CONV #( ls_icf-icf_name ) ).
        ENDIF.

      WHEN 'CREATE_PFCG_ROLE'.
        DATA ls_role TYPE ty_role_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_role ).
        IF ls_role-role IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role is empty.' ).
        ELSE.
          IF ls_role-text IS INITIAL.
            ls_role-text = |AdoptOps { ls_role-role }|.
          ENDIF.
          " reference_roles (SAP_BR_* templates) are carried for the menu
          " derivation of a later step and are not consumed here. trkorr is
          " the plan's request (empty when the plan has none yet): PFCG
          " records the role on it at creation time.
          rs_result = zcl_ado_act_role=>create_role(
            iv_role   = CONV #( ls_role-role )
            iv_text   = ls_role-text
            iv_trkorr = CONV #( ls_role-trkorr ) ).
        ENDIF.

      WHEN 'GENERATE_PROFILE'.
        DATA ls_profile TYPE ty_profile_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_profile ).
        IF ls_profile-role IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role is empty.' ).
        ELSE.
          rs_result = zcl_ado_act_role=>generate_profile(
            iv_role = CONV #( ls_profile-role ) ).
        ENDIF.

      WHEN 'ASSIGN_ROLE_TO_USERS'.
        DATA ls_assign TYPE ty_assign_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_assign ).
        IF ls_assign-role IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role is empty.' ).
        ELSE.
          rs_result = zcl_ado_act_role=>assign_users(
            iv_role  = CONV #( ls_assign-role )
            it_users = ls_assign-users ).
        ENDIF.

      WHEN 'ADD_TO_TRANSPORT'.
        DATA ls_transport TYPE ty_transport_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_transport ).
        " Two variants share the step type: { text } creates a workbench
        " request (the planner's step), { trkorr, simulation } releases
        " an existing one (releaseTransport action).
        IF ls_transport-trkorr IS NOT INITIAL.
          rs_result = zcl_ado_act_cts=>release_request(
            iv_trkorr     = CONV #( ls_transport-trkorr )
            iv_simulation = ls_transport-simulation ).
        ELSEIF ls_transport-text IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'neither text (create) nor trkorr (release) is set.' ).
        ELSE.
          rs_result = zcl_ado_act_cts=>create_request(
            iv_text = CONV #( ls_transport-text ) ).
        ENDIF.

      WHEN 'APPEND_TO_TRANSPORT'.
        DATA ls_append TYPE ty_append_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_append ).
        IF ls_append-trkorr IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'trkorr is empty - the plan has no transport request yet (ADD_TO_TRANSPORT runs first).' ).
        ELSEIF ls_append-objects IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'objects is empty.' ).
        ELSE.
          DATA lt_objects TYPE tr_objects.
          CLEAR lt_objects.
          LOOP AT ls_append-objects INTO DATA(ls_object).
            APPEND VALUE e071(
                pgmid    = ls_object-pgmid
                object   = ls_object-object
                obj_name = ls_object-obj_name ) TO lt_objects.
          ENDLOOP.
          rs_result = zcl_ado_act_cts=>append_missing(
            iv_trkorr  = CONV #( ls_append-trkorr )
            it_objects = lt_objects ).
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

  METHOD incomplete_key.
    rs_result-status = zif_ado_act_step=>c_status-failed.
    APPEND VALUE bapiret2(
        type    = 'E'
        message = |ObjectKeyJson for { iv_step_type } is incomplete: { iv_reason }| )
      TO rs_result-messages.
  ENDMETHOD.

ENDCLASS.
