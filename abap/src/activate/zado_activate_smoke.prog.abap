REPORT zado_activate_smoke.

"---------------------------------------------------------------------
" Runtime smoke test for the AdoptOps activation write unit (DEV ONLY).
"
" Executes exactly ONE step through ZCL_ADO_ACTIVATE=>EXECUTE_STEP,
" using the same StepType + ObjectKeyJson contract the SaaS planner
" persists on ActivationSteps, and prints the full result contract.
"
" Run the SAME scenario twice to see verify-first idempotency: the
" second run must come back SKIPPED with exists_already = X (role
" scenario) - never a duplicate write.
"
" Scenarios (cheap, contained):
" - Transport: creates ONE workbench request. Clean up: delete in SE10.
" - Role:      creates the smoke role (default Z_ADO_SMOKE).
"              Clean up: delete in PFCG.
" - Profile:   generates the authorization profile for the smoke role
"              (run the Role scenario first).
"
" This report performs REAL writes in the logged-on system/client.
" It ships with the write unit and must never leave DEV.
"---------------------------------------------------------------------

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_tr FOR FIELD p_tr.
PARAMETERS p_tr RADIOBUTTON GROUP g1 DEFAULT 'X'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_role FOR FIELD p_role.
PARAMETERS p_role RADIOBUTTON GROUP g1.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_prof FOR FIELD p_prof.
PARAMETERS p_prof RADIOBUTTON GROUP g1.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_rname FOR FIELD p_rname.
PARAMETERS p_rname TYPE agr_name DEFAULT 'Z_ADO_SMOKE'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_ttext FOR FIELD p_ttext.
PARAMETERS p_ttext TYPE as4text DEFAULT 'AdoptOps activation smoke test'.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_tr    = 'Create workbench transport'.
  c_role  = 'Create smoke role'.
  c_prof  = 'Generate profile (smoke role)'.
  c_rname = 'Smoke role name'.
  c_ttext = 'Transport description'.

CLASS lcl_smoke DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.
  PRIVATE SECTION.
    METHODS print
      IMPORTING iv_step_type TYPE string
                iv_json      TYPE string
                is_result    TYPE zif_ado_act_step=>ty_result.
ENDCLASS.

CLASS lcl_smoke IMPLEMENTATION.

  METHOD run.
    DATA lv_step_type TYPE string.
    DATA lv_json      TYPE string.

    " ObjectKeyJson exactly as the SaaS planner writes it (camelCase);
    " this also exercises the /UI2/CL_JSON deserialization path.
    IF p_tr = abap_true.
      lv_step_type = 'ADD_TO_TRANSPORT'.
      lv_json      = |\{ "text": "{ p_ttext }" \}|.
    ELSEIF p_role = abap_true.
      lv_step_type = 'CREATE_PFCG_ROLE'.
      lv_json      = |\{ "role": "{ p_rname }", "text": "AdoptOps smoke test role" \}|.
    ELSE.
      lv_step_type = 'GENERATE_PROFILE'.
      lv_json      = |\{ "role": "{ p_rname }" \}|.
    ENDIF.

    DATA(ls_result) = zcl_ado_activate=>execute_step(
      iv_step_type       = lv_step_type
      iv_object_key_json = lv_json ).

    print( iv_step_type = lv_step_type
           iv_json      = lv_json
           is_result    = ls_result ).
  ENDMETHOD.

  METHOD print.
    WRITE: / 'AdoptOps activation smoke test'.
    WRITE: / '------------------------------------------------------'.
    WRITE: / |System/client:  { sy-sysid }/{ sy-mandt } as { sy-uname }|.
    WRITE: / |Step type:      { iv_step_type }|.
    WRITE: / |ObjectKeyJson:  { iv_json }|.
    WRITE: / '------------------------------------------------------'.
    WRITE: / |Status:         { is_result-status }|.
    WRITE: / |Exists already: { COND string( WHEN is_result-exists_already = abap_true THEN 'X' ELSE '-' ) }|.
    WRITE: / |Transport:      { COND string( WHEN is_result-trkorr IS NOT INITIAL THEN |{ is_result-trkorr }| ELSE '-' ) }|.
    WRITE: / |Messages:       { lines( is_result-messages ) }|.
    LOOP AT is_result-messages ASSIGNING FIELD-SYMBOL(<ls_msg>).
      WRITE: / |  [{ <ls_msg>-type }] { <ls_msg>-message }|.
    ENDLOOP.
    WRITE: / '------------------------------------------------------'.
    IF is_result-status = zif_ado_act_step=>c_status-failed.
      WRITE: / 'FAILED - the step LUW was rolled back; see messages.'.
    ELSEIF is_result-exists_already = abap_true.
      WRITE: / 'SKIPPED (verify-first): the object already exists - idempotency confirmed.'.
    ELSEIF iv_step_type = 'CREATE_PFCG_ROLE'.
      WRITE: / 'Executed. Run the SAME scenario again: it must come back SKIPPED (verify-first proof).'.
    ELSEIF iv_step_type = 'ADD_TO_TRANSPORT'.
      WRITE: / 'Executed. Each transport run creates a NEW request (delete extras in SE10);'.
      WRITE: / 'the verify-first/idempotency proof is the Role scenario.'.
    ELSE.
      WRITE: / 'Executed. Re-running regenerates the profile (harmless).'.
    ENDIF.
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_smoke( )->run( ).
