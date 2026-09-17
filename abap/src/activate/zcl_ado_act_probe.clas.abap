CLASS zcl_ado_act_probe DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Read-side state probe behind simulateActivationPlan (S4).
    "
    " Same StepType + ObjectKeyJson contract as ZCL_ADO_ACTIVATE=>
    " EXECUTE_STEP, but it only READS: is the object already in its
    " target state (exists_already -> the executor will SKIP), can the
    " step run at all (BLOCKED when the key is incomplete or no executor
    " exists on this release), or does it carry a caveat (WARNING, e.g.
    " irreversible ICF activation). No LUW, no COMMIT - safe to call
    " from the RAP handler directly and from the ICF front door.
    "
    " The verdict strings are the CAP simulation statuses
    " (zif_ado_act_step=>c_verdict); the CAP adapter maps the JSON
    " { verdict, existsAlready, message } onto the step row unchanged.
    "---------------------------------------------------------------
    CLASS-METHODS probe_step
      IMPORTING iv_step_type       TYPE string
                iv_object_key_json TYPE string
      RETURNING VALUE(rs_probe)    TYPE zif_ado_act_step=>ty_probe.

  PRIVATE SECTION.
    CLASS-METHODS parse
      IMPORTING iv_json TYPE string
      CHANGING  cs_key  TYPE any.

    CLASS-METHODS verdict
      IMPORTING iv_verdict      TYPE string
                iv_message      TYPE string
                iv_exists       TYPE abap_bool DEFAULT abap_false
      RETURNING VALUE(rs_probe) TYPE zif_ado_act_step=>ty_probe.

ENDCLASS.


CLASS zcl_ado_act_probe IMPLEMENTATION.

  METHOD parse.
    /ui2/cl_json=>deserialize(
      EXPORTING json        = iv_json
                pretty_name = /ui2/cl_json=>pretty_mode-camel_case
      CHANGING  data        = cs_key ).
  ENDMETHOD.

  METHOD verdict.
    rs_probe-verdict        = iv_verdict.
    rs_probe-exists_already = iv_exists.
    rs_probe-message        = iv_message.
  ENDMETHOD.

  METHOD probe_step.
    CASE iv_step_type.

      WHEN 'RUN_TASK_LIST'.
        DATA ls_tasklist TYPE zcl_ado_activate=>ty_tasklist_key.
        parse( EXPORTING iv_json = iv_object_key_json CHANGING cs_key = ls_tasklist ).
        IF ls_tasklist-scenario IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = 'ObjectKeyJson carries no scenario.' ).
        ELSE.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_message = |Task list { ls_tasklist-scenario } runs verify-first at execution (STC01 history is not read by the probe).| ).
        ENDIF.

      WHEN 'ACTIVATE_ICF_NODE'.
        DATA ls_icf TYPE zcl_ado_activate=>ty_icf_key.
        parse( EXPORTING iv_json = iv_object_key_json CHANGING cs_key = ls_icf ).
        IF ls_icf-url IS INITIAL OR ls_icf-icf_name IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = |No ICF node known for app { ls_icf-fiori_id } (catalog derivation has not resolved its BSP application) - the step cannot run.| ).
        ELSEIF zcl_ado_act_icf=>is_node_active( CONV #( ls_icf-icf_name ) ) = abap_true.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_exists  = abap_true
                              iv_message = |ICF node { ls_icf-icf_name } is already active - step will be skipped.| ).
        ELSE.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-warning
                              iv_message = |ICF node { ls_icf-icf_name } is inactive; activation is irreversible on this release (no HTTP_DEACTIVATE_NODE).| ).
        ENDIF.

      WHEN 'CREATE_PFCG_ROLE'.
        DATA ls_role TYPE zcl_ado_activate=>ty_role_key.
        parse( EXPORTING iv_json = iv_object_key_json CHANGING cs_key = ls_role ).
        IF ls_role-role IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = 'ObjectKeyJson carries no role.' ).
        ELSEIF zcl_ado_act_role=>role_exists( CONV #( ls_role-role ) ) = abap_true.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_exists  = abap_true
                              iv_message = |Role { ls_role-role } already exists - step will be skipped.| ).
        ELSE.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_message = |Role { ls_role-role } does not exist - it will be created{ COND #( WHEN ls_role-trkorr IS NOT INITIAL THEN | on { ls_role-trkorr }| ) }.| ).
        ENDIF.

      WHEN 'GENERATE_PROFILE' OR 'ASSIGN_ROLE_TO_USERS'.
        DATA ls_profile TYPE zcl_ado_activate=>ty_profile_key.
        parse( EXPORTING iv_json = iv_object_key_json CHANGING cs_key = ls_profile ).
        IF ls_profile-role IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = 'ObjectKeyJson carries no role.' ).
        ELSEIF zcl_ado_act_role=>role_exists( CONV #( ls_profile-role ) ) = abap_true.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_message = |Role { ls_profile-role } exists - { iv_step_type } runs against it.| ).
        ELSE.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_message = |Role { ls_profile-role } does not exist yet - an earlier step of this plan creates it.| ).
        ENDIF.

      WHEN 'ADD_TO_TRANSPORT'.
        DATA ls_transport TYPE zcl_ado_activate=>ty_transport_key.
        parse( EXPORTING iv_json = iv_object_key_json CHANGING cs_key = ls_transport ).
        IF ls_transport-trkorr IS NOT INITIAL.
          DATA(lv_status) = zcl_ado_act_cts=>read_status( CONV #( ls_transport-trkorr ) ).
          IF lv_status IS INITIAL.
            rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                                iv_message = |Transport request { ls_transport-trkorr } does not exist (E070).| ).
          ELSEIF lv_status = 'R'.
            rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                                iv_exists  = abap_true
                                iv_message = |{ ls_transport-trkorr } is already released - step will be skipped.| ).
          ELSE.
            rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                                iv_message = |{ ls_transport-trkorr } is modifiable (E070 status { lv_status }) - release possible.| ).
          ENDIF.
        ELSEIF ls_transport-text IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = 'ObjectKeyJson carries neither text (create) nor trkorr (release).' ).
        ELSE.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_message = |A new workbench request "{ ls_transport-text }" will be created.| ).
        ENDIF.

      WHEN 'APPEND_TO_TRANSPORT'.
        DATA ls_append TYPE zcl_ado_activate=>ty_append_key.
        parse( EXPORTING iv_json = iv_object_key_json CHANGING cs_key = ls_append ).
        IF ls_append-objects IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = 'ObjectKeyJson carries no objects.' ).
        ELSEIF ls_append-trkorr IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                              iv_message = |{ lines( ls_append-objects ) } object(s) will be appended to the request this plan creates.| ).
        ELSEIF zcl_ado_act_cts=>read_status( CONV #( ls_append-trkorr ) ) IS INITIAL.
          rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                              iv_message = |Transport request { ls_append-trkorr } does not exist (E070).| ).
        ELSE.
          DATA(lt_existing) = zcl_ado_act_cts=>read_objects( CONV #( ls_append-trkorr ) ).
          DATA lv_missing TYPE i.
          CLEAR lv_missing.
          LOOP AT ls_append-objects INTO DATA(ls_object).
            IF NOT line_exists( lt_existing[ pgmid    = ls_object-pgmid
                                             object   = ls_object-object
                                             obj_name = ls_object-obj_name ] ).
              lv_missing = lv_missing + 1.
            ENDIF.
          ENDLOOP.
          IF lv_missing = 0.
            rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                                iv_exists  = abap_true
                                iv_message = |All { lines( ls_append-objects ) } object(s) are already on { ls_append-trkorr } - step will be skipped.| ).
          ELSE.
            rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-ok
                                iv_message = |{ lv_missing } of { lines( ls_append-objects ) } object(s) still to append to { ls_append-trkorr }.| ).
          ENDIF.
        ENDIF.

      WHEN 'ACTIVATE_ODATA_SERVICE' OR 'CREATE_SPACE' OR 'CREATE_PAGE' OR 'ASSIGN_PAGE_TO_SPACE'
        OR 'ADD_SPACE_TO_ROLE' OR 'ASSIGN_BUSINESS_CATALOG' OR 'ADD_CATALOG_TO_ROLE'.
        rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                            iv_message = |{ iv_step_type } has no executor in this release of the write unit (roadmap S3) - execution would stop at this step.| ).

      WHEN OTHERS.
        rs_probe = verdict( iv_verdict = zif_ado_act_step=>c_verdict-blocked
                            iv_message = |Unknown step type { iv_step_type }.| ).
    ENDCASE.
  ENDMETHOD.

ENDCLASS.
