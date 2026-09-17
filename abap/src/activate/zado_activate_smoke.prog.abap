REPORT zado_activate_smoke.

"---------------------------------------------------------------------
" Runtime smoke test for the AdoptOps activation write unit (DEV ONLY).
"
" Executes exactly ONE step through ZCL_ADO_ACTIVATE=>EXECUTE_STEP,
" using the same StepType + ObjectKeyJson contract the SaaS planner
" persists on ActivationSteps, and prints the full result contract.
"
" The JSON literals below are the planner's key shapes VERBATIM: the
" key names come from code/test/fixtures/activation-object-keys.json
" in Cx_SaaS_Fiori, and a CAP test parses this program and fails when
" they drift. The "Custom" scenario takes a StepType + ObjectKeyJson
" pasted from an ActivationSteps row, unchanged.
"
" Run the SAME scenario twice to see verify-first idempotency: the
" second run must come back SKIPPED with exists_already = X (role and
" ICF scenarios) - never a duplicate write.
"
" Scenarios (cheap, contained):
" - Transport: creates ONE workbench request. Clean up: delete in SE10.
" - Role:      creates the smoke role (default Z_ADO_SMOKE).
"              Clean up: delete in PFCG.
" - Profile:   generates the authorization profile for the smoke role
"              (run the Role scenario first).
" - ICF:       activates ONE ICF node via HTTP_ACTIVATE_NODE. The
"              default node is the launchpad shell
"              (/sap/bc/ui5_ui5/ui2/ushell), active on every Fiori
"              system, so the default run proves the verify-first path
"              (SKIPPED + exists_already) without writing. Point it at
"              an inactive app node (SICF) to see the FM run; ICF
"              activation is IRREVERSIBLE on this release.
" - Append:    records the smoke role (R3TR ACGR) on the given workbench
"              request via APPEND_TO_TRANSPORT. Create the request with
"              the Transport scenario first; the second run must come
"              back SKIPPED (verify-first on E071).
" - Custom:    StepType + ObjectKeyJson exactly as the planner wrote
"              them (copy from ActivationSteps).
"
" "Probe only" runs the same scenario through ZCL_ADO_ACT_PROBE (the
" simulation path): it reports verdict + exists_already and writes
" nothing - the way to check a scenario before executing it.
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
SELECTION-SCREEN COMMENT 1(31) c_icf FOR FIELD p_icf.
PARAMETERS p_icf RADIOBUTTON GROUP g1.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_app FOR FIELD p_app.
PARAMETERS p_app RADIOBUTTON GROUP g1.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_cust FOR FIELD p_cust.
PARAMETERS p_cust RADIOBUTTON GROUP g1.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN SKIP.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_probe FOR FIELD p_probe.
PARAMETERS p_probe AS CHECKBOX.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN SKIP.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_rname FOR FIELD p_rname.
PARAMETERS p_rname TYPE agr_name DEFAULT 'Z_ADO_SMOKE'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_ttext FOR FIELD p_ttext.
PARAMETERS p_ttext TYPE as4text DEFAULT 'AdoptOps activation smoke test'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_url FOR FIELD p_url.
PARAMETERS p_url TYPE c LENGTH 120 LOWER CASE VISIBLE LENGTH 60
  DEFAULT '/sap/bc/ui5_ui5/ui2/ushell'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_icfn FOR FIELD p_icfn.
PARAMETERS p_icfn TYPE icfname LOWER CASE DEFAULT 'ushell'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_trk FOR FIELD p_trk.
PARAMETERS p_trk TYPE trkorr.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_step FOR FIELD p_step.
PARAMETERS p_step TYPE c LENGTH 40 DEFAULT 'CREATE_PFCG_ROLE'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_json FOR FIELD p_json.
PARAMETERS p_json TYPE c LENGTH 255 LOWER CASE VISIBLE LENGTH 60.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_tr    = 'Create workbench transport'.
  c_role  = 'Create smoke role'.
  c_prof  = 'Generate profile (smoke role)'.
  c_icf   = 'Activate ICF node'.
  c_app   = 'Append smoke role to transport'.
  c_cust  = 'Custom (planner StepType+JSON)'.
  c_trk   = 'Transport for Append (SE10)'.
  c_probe = 'Probe only (read state, no write)'.
  c_rname = 'Smoke role name'.
  c_ttext = 'Transport description'.
  c_url   = 'ICF node URL'.
  c_icfn  = 'ICF node name (ICFSERVICE)'.
  c_step  = 'Custom: StepType'.
  c_json  = 'Custom: ObjectKeyJson'.

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

    " ObjectKeyJson exactly as the SaaS planner writes it (camelCase,
    " key names = activation-object-keys.json); this also exercises
    " the /UI2/CL_JSON deserialization path.
    IF p_tr = abap_true.
      lv_step_type = 'ADD_TO_TRANSPORT'.
      lv_json      = |\{ "text": "{ p_ttext }" \}|.
    ELSEIF p_role = abap_true.
      lv_step_type = 'CREATE_PFCG_ROLE'.
      lv_json      = |\{ "role": "{ p_rname }", "text": "AdoptOps smoke test role", "referenceRoles": [] \}|.
    ELSEIF p_prof = abap_true.
      lv_step_type = 'GENERATE_PROFILE'.
      lv_json      = |\{ "role": "{ p_rname }" \}|.
    ELSEIF p_icf = abap_true.
      lv_step_type = 'ACTIVATE_ICF_NODE'.
      lv_json      = |\{ "fioriId": "SMOKE", "url": "{ p_url }", "icfName": "{ p_icfn }" \}|.
    ELSEIF p_app = abap_true.
      lv_step_type = 'APPEND_TO_TRANSPORT'.
      lv_json      = |\{ "trkorr": "{ p_trk }", "objects": [ \{ "pgmid": "R3TR", "object": "ACGR", "objName": "{ p_rname }" \} ] \}|.
    ELSE.
      lv_step_type = p_step.
      lv_json      = p_json.
    ENDIF.

    " Probe only: the simulation path (ZCL_ADO_ACT_PROBE) - reads the
    " target state for the same key and writes nothing.
    IF p_probe = abap_true.
      DATA(ls_probe) = zcl_ado_act_probe=>probe_step(
        iv_step_type       = lv_step_type
        iv_object_key_json = lv_json ).
      WRITE: / 'AdoptOps activation state probe (read-only)'.
      WRITE: / '------------------------------------------------------'.
      WRITE: / |System/client:  { sy-sysid }/{ sy-mandt } as { sy-uname }|.
      WRITE: / |Step type:      { lv_step_type }|.
      WRITE: / |ObjectKeyJson:  { lv_json }|.
      WRITE: / '------------------------------------------------------'.
      WRITE: / |Verdict:        { ls_probe-verdict }|.
      WRITE: / |Exists already: { COND string( WHEN ls_probe-exists_already = abap_true THEN 'X' ELSE '-' ) }|.
      WRITE: / |Message:        { ls_probe-message }|.
      RETURN.
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
    ELSEIF iv_step_type = 'ACTIVATE_ICF_NODE'.
      WRITE: / 'Executed. The node is now active and cannot be deactivated by this unit (irreversible);'.
      WRITE: / 'run the SAME scenario again: it must come back SKIPPED (verify-first proof).'.
    ELSE.
      WRITE: / 'Executed. Re-running is expected to be idempotent (SKIPPED) or harmless.'.
    ENDIF.
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_smoke( )->run( ).
