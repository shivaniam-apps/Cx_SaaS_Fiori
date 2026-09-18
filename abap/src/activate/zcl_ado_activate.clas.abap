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
    " PORTABILITY: the executors that sit on release-dependent SAP APIs
    " (gateway activation API, FDM space / page API, CL_PFCG_MENU_MODIFY)
    " live in their own classes and are called DYNAMICALLY (call_executor).
    " On a system where such an API is missing, that one class stays
    " inactive and its step types answer FAILED "not available on this
    " system" - the dispatcher and every other step type keep working.
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
    TYPES: BEGIN OF ty_odata_key,             " ACTIVATE_ODATA_SERVICE
             fiori_id        TYPE string,     "   one step per service of
             scenario        TYPE string,     "   the app's catalog; an
             service_name    TYPE string,     "   empty serviceName fails
             service_version TYPE string,     "   fast (no catalog data)
             system_alias    TYPE string,
           END OF ty_odata_key.
    TYPES: BEGIN OF ty_space_key,             " CREATE_SPACE
             space_id TYPE string,
             title    TYPE string,
             trkorr   TYPE string,            "   injected by the engine
           END OF ty_space_key.
    TYPES: BEGIN OF ty_page_key,              " CREATE_PAGE
             page_id TYPE string,
             title   TYPE string,
             apps    TYPE string_table,
             trkorr  TYPE string,             "   injected by the engine
           END OF ty_page_key.
    TYPES: BEGIN OF ty_space_page_key,        " ASSIGN_PAGE_TO_SPACE
             space_id TYPE string,
             page_id  TYPE string,
             trkorr   TYPE string,            "   injected by the engine
           END OF ty_space_page_key.
    TYPES: BEGIN OF ty_role_space_key,        " ADD_SPACE_TO_ROLE
             role     TYPE string,
             space_id TYPE string,
           END OF ty_role_space_key.
    TYPES: BEGIN OF ty_role_catalog_key,      " ADD_CATALOG_TO_ROLE /
             role       TYPE string,          " ASSIGN_BUSINESS_CATALOG
             catalog_id TYPE string,
           END OF ty_role_catalog_key.
    TYPES: BEGIN OF ty_append_key,            " APPEND_TO_TRANSPORT
             trkorr  TYPE string,             "   injected by the engine
             objects TYPE ty_append_objects,
           END OF ty_append_key.

    CLASS-METHODS execute_step
      IMPORTING iv_step_type       TYPE string
                iv_object_key_json TYPE string
      RETURNING VALUE(rs_result)   TYPE zif_ado_act_step=>ty_result.

  PRIVATE SECTION.
    " Dynamic call of <class>=>EXECUTE( iv_step_type, iv_object_key_json ).
    " A class that is missing or inactive on this system is reported as
    " FAILED with the reason - never a dump, never a dead write unit.
    CLASS-METHODS call_executor
      IMPORTING iv_class           TYPE string
                iv_step_type       TYPE string
                iv_object_key_json TYPE string
      RETURNING VALUE(rs_result)   TYPE zif_ado_act_step=>ty_result.

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

      " Operator rollback (rollbackActivationStep): ROLLBACK_<type> undoes
      " an executed step. Reversible types only - ICF activation and task
      " lists are irreversible on this release and stay audit-only on the
      " SaaS side.
      WHEN 'ROLLBACK_CREATE_PFCG_ROLE'.
        DATA ls_rb_role TYPE ty_profile_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_rb_role ).
        IF ls_rb_role-role IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role is empty.' ).
        ELSE.
          rs_result = zcl_ado_act_role=>delete_role(
            iv_role = CONV #( ls_rb_role-role ) ).
        ENDIF.

      WHEN 'ROLLBACK_GENERATE_PROFILE'.
        DATA ls_rb_profile TYPE ty_profile_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_rb_profile ).
        " The generated profile lives and dies with its role
        " (ROLLBACK_CREATE_PFCG_ROLE); there is nothing separate to undo.
        rs_result-status = zif_ado_act_step=>c_status-success.
        APPEND VALUE bapiret2(
            type    = 'S'
            message = |Authorization profile of { ls_rb_profile-role } is dropped with the role - nothing to undo here.| )
          TO rs_result-messages.

      WHEN 'ROLLBACK_ACTIVATE_ICF_NODE' OR 'ROLLBACK_RUN_TASK_LIST'.
        rs_result = not_implemented(
          iv_step_type = iv_step_type
          iv_reason    = 'Irreversible on this release (no HTTP_DEACTIVATE_NODE, no task-list undo) - rollback is audit-only.' ).

      WHEN 'ACTIVATE_ODATA_SERVICE'.
        DATA ls_odata TYPE ty_odata_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_odata ).
        IF ls_odata-service_name IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = |serviceName is empty for app { ls_odata-fiori_id } - | &&
                           |run catalog derivation so the OData services of the app's catalog are known.| ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_ODATA'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

      WHEN 'CREATE_SPACE'.
        DATA ls_space TYPE ty_space_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_space ).
        IF ls_space-space_id IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'spaceId is empty.' ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_SPACE'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

      WHEN 'CREATE_PAGE'.
        DATA ls_page TYPE ty_page_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_page ).
        IF ls_page-page_id IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'pageId is empty.' ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_SPACE'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

      WHEN 'ASSIGN_PAGE_TO_SPACE'.
        DATA ls_space_page TYPE ty_space_page_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_space_page ).
        IF ls_space_page-space_id IS INITIAL OR ls_space_page-page_id IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'spaceId / pageId are empty.' ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_SPACE'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

      WHEN 'ADD_SPACE_TO_ROLE'.
        DATA ls_role_space TYPE ty_role_space_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_role_space ).
        IF ls_role_space-role IS INITIAL OR ls_role_space-space_id IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role / spaceId are empty.' ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_MENU'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

      WHEN 'ADD_CATALOG_TO_ROLE'.
        DATA ls_role_catalog TYPE ty_role_catalog_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_role_catalog ).
        IF ls_role_catalog-role IS INITIAL OR ls_role_catalog-catalog_id IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role / catalogId are empty.' ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_MENU'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

      WHEN 'ASSIGN_BUSINESS_CATALOG'.
        DATA ls_bus_catalog TYPE ty_role_catalog_key.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_object_key_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data = ls_bus_catalog ).
        IF ls_bus_catalog-role IS INITIAL OR ls_bus_catalog-catalog_id IS INITIAL.
          rs_result = incomplete_key(
            iv_step_type = iv_step_type
            iv_reason    = 'role / catalogId are empty.' ).
        ELSE.
          rs_result = call_executor(
            iv_class           = 'ZCL_ADO_ACT_MENU'
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json ).
        ENDIF.

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

  METHOD call_executor.
    DATA(lv_class) = to_upper( iv_class ).
    TRY.
        CALL METHOD (lv_class)=>('EXECUTE')
          EXPORTING
            iv_step_type       = iv_step_type
            iv_object_key_json = iv_object_key_json
          RECEIVING
            rs_result          = rs_result.
      CATCH cx_sy_dyn_call_error INTO DATA(lx_call).
        rs_result = not_implemented(
          iv_step_type = iv_step_type
          iv_reason    = |{ lv_class } is not available on this system ({ lx_call->get_text( ) }) - perform the step manually.| ).
    ENDTRY.
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
