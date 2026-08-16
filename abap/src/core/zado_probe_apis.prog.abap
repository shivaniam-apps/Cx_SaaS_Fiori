REPORT zado_probe_apis.

"---------------------------------------------------------------------
" AdoptOps Phase 0 probe (read-only).
"
" Answers, against THIS system, every API/table uncertainty in the
" AdoptOps design before any downstream ZADO code is written:
"   1. System identity, component versions, change options
"   2. Candidate function modules: existence + parameter signatures
"   3. Workload collector job + SWNC aggregate inventory (ST03N periods)
"   4. Candidate tables (/UI2/*, IAM, FDM/CDM, STC, ICF) via DD02L
"   5. SAP_BR_* business role menu representation (AGR_* shape)
"   6. Manual follow-ups the probe cannot decide by itself
"
" The report only SELECTs. It creates, changes and activates nothing.
" Run via SE38 and attach the full list output to the API matrix in
" docu/06-s4-integration.
"---------------------------------------------------------------------

CLASS lcl_probe DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.
  PRIVATE SECTION.
    METHODS section IMPORTING iv_title TYPE string.
    METHODS line IMPORTING iv_text TYPE string.
    METHODS probe_system_identity.
    METHODS probe_function_modules.
    METHODS probe_collector_and_swnc.
    METHODS probe_tables.
    METHODS probe_field_lists.
    METHODS probe_stc_scenarios.
    METHODS probe_business_roles.
    METHODS manual_follow_ups.
    METHODS fm_signature IMPORTING iv_funcname TYPE tfdir-funcname.
    METHODS count_tables IMPORTING iv_pattern TYPE string
                         RETURNING VALUE(rv_count) TYPE i.
    METHODS list_tables IMPORTING iv_pattern TYPE string
                                  iv_max     TYPE i DEFAULT 40.
ENDCLASS.

CLASS lcl_probe IMPLEMENTATION.

  METHOD run.
    line( |AdoptOps API probe - { sy-datum DATE = ISO } { sy-uzeit TIME = ISO }| ).
    probe_system_identity( ).
    probe_function_modules( ).
    probe_collector_and_swnc( ).
    probe_tables( ).
    probe_field_lists( ).
    probe_stc_scenarios( ).
    probe_business_roles( ).
    manual_follow_ups( ).
    section( 'END OF PROBE' ).
  ENDMETHOD.

  METHOD section.
    SKIP.
    WRITE: / '==================================================================='.
    WRITE: / iv_title.
    WRITE: / '==================================================================='.
  ENDMETHOD.

  METHOD line.
    WRITE: / iv_text.
  ENDMETHOD.

  METHOD probe_system_identity.
    section( '1. SYSTEM IDENTITY' ).
    line( |System: { sy-sysid } client { sy-mandt } host { sy-host }| ).
    line( |SAP_BASIS release: { sy-saprl }| ).

    " Component versions that gate the design (S4CORE = S/4 release,
    " SAP_UI = Fiori frontend components, SAP_GWFND = gateway).
    SELECT component, release, extrelease
      FROM cvers
      WHERE component IN ( 'S4CORE', 'SAP_UI', 'SAP_GWFND', 'SAP_BASIS', 'UIBAS001' )
      INTO TABLE @DATA(lt_cvers).
    LOOP AT lt_cvers INTO DATA(ls_cvers).
      line( |Component { ls_cvers-component } release { ls_cvers-release } SP { ls_cvers-extrelease }| ).
    ENDLOOP.

    " Client role and change option (T000): a plan must never execute in a
    " client whose role/change settings forbid it.
    SELECT SINGLE cccategory, cccoractiv, ccnocliind
      FROM t000
      WHERE mandt = @sy-mandt
      INTO @DATA(ls_t000).
    IF sy-subrc = 0.
      line( |Client role: { ls_t000-cccategory } (C=customizing P=production T=test)| ).
      line( |Client change option: { ls_t000-cccoractiv }, cross-client: { ls_t000-ccnocliind }| ).
    ENDIF.
  ENDMETHOD.

  METHOD probe_function_modules.
    section( '2. CANDIDATE FUNCTION MODULES - EXISTENCE AND SIGNATURES' ).
    line( 'Usage extraction (SWNC/ST03N and STAD):' ).
    fm_signature( 'SWNC_COLLECTOR_GET_AGGREGATES' ).
    fm_signature( 'SWNC_GET_WORKLOAD_STATISTIC' ).
    fm_signature( 'SAPWL_WORKLOAD_GET_STATISTIC' ).
    fm_signature( 'SAPWL_WORKLOAD_GET_SUMMARY' ).
    fm_signature( 'SWNC_STAD_READ_STATRECS' ).
    fm_signature( 'SAPWL_STATREC_READ_REMOTE' ).
    fm_signature( 'SAPWL_STATREC_DIRECT_READ' ).
    fm_signature( 'SAPWL_READ_STATISTIC_FILES' ).

    line( 'ICF activation (HTTP_DEACTIVATE_NODE was MISSING in run 1 - candidates):' ).
    fm_signature( 'HTTP_ACTIVATE_NODE' ).
    fm_signature( 'HTTP_DEACTIVATE_NODES' ).
    fm_signature( 'HTTP_ACTIVATE_NODES' ).
    fm_signature( 'HTTP_UPDATE_NODE' ).

    line( 'PFCG / roles:' ).
    fm_signature( 'PRGN_RFC_CREATE_AGR_MULTIPLE' ).
    fm_signature( 'PRGN_RFC_CREATE_ACTIVITY_GROUP' ).
    fm_signature( 'PRGN_READ_ROLE_MENU' ).
    fm_signature( 'PRGN_AUTO_GENERATE_PROFILE_NEW' ).
    fm_signature( 'BAPI_USER_ACTGROUPS_ASSIGN' ).
    " PFCG_TIME_DEPENDENCY was MISSING in run 1; user master comparison
    " candidates (else SUBMIT report RHAUTUPD_NEW in a background job):
    fm_signature( 'PRGN_UPDATE_DATABASE' ).
    fm_signature( 'SUSR_USER_BUFFER_AFTER_CHANGE' ).

    line( 'Transport (CTS):' ).
    fm_signature( 'TR_INSERT_NEW_COMM' ).
    fm_signature( 'TRINT_INSERT_NEW_COMM' ).
    fm_signature( 'TR_APPEND_TO_COMM_OBJS_KEYS' ).
    fm_signature( 'TR_OBJECTS_CHECK' ).
    fm_signature( 'TR_READ_COMM' ).
    fm_signature( 'TR_RELEASE_REQUEST' ).
    fm_signature( 'TRINT_RELEASE_REQUEST' ).

    line( 'Task manager (STC01) - session lifecycle candidates (run 2):' ).
    fm_signature( 'STC_TM_SESSION_BEGIN' ).
    fm_signature( 'STC_TM_SESSION_START' ).
    fm_signature( 'STC_TM_SESSION_RESUME' ).
    fm_signature( 'STC_TM_SESSION_GET_STATUS' ).
    fm_signature( 'STC_TM_SESSION_SET_PARAMETERS' ).
    fm_signature( 'STC_TM_TASKLIST_EXECUTE' ).
  ENDMETHOD.

  METHOD fm_signature.
    SELECT SINGLE funcname FROM tfdir WHERE funcname = @iv_funcname INTO @DATA(lv_found).
    IF sy-subrc <> 0.
      line( |  { iv_funcname }: MISSING| ).
      RETURN.
    ENDIF.

    line( |  { iv_funcname }: exists| ).
    " Parameter signature from FUPARAREF: kind P=importing, E=exporting,
    " T=tables, C=changing. STRUCTURE column carries the typing.
    SELECT parameter, paramtype, structure
      FROM fupararef
      WHERE funcname = @iv_funcname
        AND r3state  = 'A'
      ORDER BY paramtype, pposition
      INTO TABLE @DATA(lt_params).
    LOOP AT lt_params INTO DATA(ls_param).
      line( |      { ls_param-paramtype } { ls_param-parameter } TYPE { ls_param-structure }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD probe_collector_and_swnc.
    section( '3. WORKLOAD COLLECTOR AND SWNC AGGREGATE INVENTORY' ).

    " Without SAP_COLLECTOR_FOR_PERFMONITOR there is no ST03N history and
    " no usage product. Released/active job definitions live in TBTCO.
    SELECT jobname, status, sdlstrtdt, sdluname
      FROM tbtco
      WHERE jobname = 'SAP_COLLECTOR_FOR_PERFMONITOR'
      ORDER BY sdlstrtdt DESCENDING
      INTO TABLE @DATA(lt_jobs)
      UP TO 5 ROWS.
    IF lt_jobs IS INITIAL.
      line( 'SAP_COLLECTOR_FOR_PERFMONITOR: NO job found - ST03N data collection' ).
      line( '  is NOT running. This must be fixed before any usage extraction.' ).
    ELSE.
      LOOP AT lt_jobs INTO DATA(ls_job).
        line( |SAP_COLLECTOR_FOR_PERFMONITOR: status { ls_job-status } scheduled { ls_job-sdlstrtdt DATE = ISO } by { ls_job-sdluname }| ).
      ENDLOOP.
    ENDIF.

    " SWNC aggregate inventory: which (component, period type, period start)
    " triples actually exist. Read via dynamic SQL: the index table name and
    " columns differ between releases; failure degrades to a manual step.
    DATA lr_data TYPE REF TO data.
    FIELD-SYMBOLS <lt_any> TYPE STANDARD TABLE.
    LOOP AT VALUE string_table( ( `SWNCMONIINDEX` ) ( `SWNCMONI` ) ) INTO DATA(lv_tab).
      SELECT SINGLE tabname FROM dd02l
        WHERE tabname = @lv_tab AND as4local = 'A'
        INTO @DATA(lv_exists).
      IF sy-subrc <> 0.
        line( |{ lv_tab }: table does not exist in this release| ).
        CONTINUE.
      ENDIF.
      TRY.
          CREATE DATA lr_data TYPE STANDARD TABLE OF (lv_tab).
          ASSIGN lr_data->* TO <lt_any>.
          SELECT * FROM (lv_tab) INTO TABLE @<lt_any> UP TO 20 ROWS.
          line( |{ lv_tab }: exists, sample rows read: { lines( <lt_any> ) } (inspect in SE16 for COMPONENT/PERIODTYPE/PERIODSTRT values)| ).
        CATCH cx_root INTO DATA(lx_error).
          line( |{ lv_tab }: read failed - { lx_error->get_text( ) } - inspect manually in SE16| ).
      ENDTRY.
    ENDLOOP.
  ENDMETHOD.

  METHOD probe_tables.
    section( '4. CANDIDATE TABLE INVENTORY (DD02L)' ).
    line( 'Spaces and pages repository (run 1: FDM% matched nothing here):' ).
    list_tables( '/UI2/ST%' ).
    list_tables( '/UI2/PG%' ).
    line( 'Target mappings / launchpad designer content:' ).
    list_tables( '/UI2/TM%' ).
    list_tables( '/UI2/CHIP%' ).
    line( 'IAM apps / business catalogs (absent on plain ABAP Platform):' ).
    list_tables( '%IAM%APP%' ).
    list_tables( 'FDM%' ).
  ENDMETHOD.

  " Field lists for structures/tables run 1 confirmed but whose columns the
  " design still needs: the user x tcode aggregate (client dimension?) and
  " ICFSERVICE (where does the activation state live?).
  METHOD probe_field_lists.
    section( '4b. FIELD LISTS (DD03L) FOR CONFIRMED STRUCTURES' ).
    LOOP AT VALUE string_table( ( `SWNCAGGUSERTCODE` ) ( `SWNCAGGTCDET` )
                                ( `ICFSERVICE` ) ) INTO DATA(lv_struct).
      DATA lv_tabname TYPE dd03l-tabname.
      lv_tabname = lv_struct.
      SELECT fieldname, rollname, position
        FROM dd03l
        WHERE tabname  = @lv_tabname
          AND as4local = 'A'
        ORDER BY position
        INTO TABLE @DATA(lt_fields).
      IF lt_fields IS INITIAL.
        line( |{ lv_struct }: no DD03L fields (check SE11 manually)| ).
        CONTINUE.
      ENDIF.
      line( |{ lv_struct }:| ).
      LOOP AT lt_fields INTO DATA(ls_field).
        line( |      { ls_field-fieldname } TYPE { ls_field-rollname }| ).
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  " Run 1 confirmed the STC_TM read FMs; use them to list the scenarios so
  " the Fiori task-list names stop being a manual step.
  METHOD probe_stc_scenarios.
    section( '4c. STC01 SCENARIO INVENTORY (via STC_TM_GET_SCENARIO_LIST)' ).
    DATA lt_scenario TYPE STANDARD TABLE OF stc_s_scenario.
    DATA lt_return   TYPE bapirettab.
    TRY.
        CALL FUNCTION 'STC_TM_GET_SCENARIO_LIST'
          TABLES
            et_scenario = lt_scenario
            et_return   = lt_return.
        line( |Scenarios found: { lines( lt_scenario ) } - Fiori-relevant ones:| ).
        LOOP AT lt_scenario ASSIGNING FIELD-SYMBOL(<ls_scenario>).
          DATA(lv_id) = CONV string( <ls_scenario>-scenario_id ).
          IF lv_id CS 'FIORI' OR lv_id CS 'GATEWAY' OR lv_id CS 'UI2'.
            line( |      { lv_id }| ).
          ENDIF.
        ENDLOOP.
        line( '(full list: run STC01 or raise the filter above)' ).
      CATCH cx_root INTO DATA(lx_error).
        line( |STC_TM_GET_SCENARIO_LIST call failed: { lx_error->get_text( ) }| ).
        line( '(fall back to listing scenarios in STC01 manually)' ).
    ENDTRY.
  ENDMETHOD.

  METHOD count_tables.
    DATA lv_pattern TYPE dd02l-tabname.
    lv_pattern = iv_pattern.
    SELECT COUNT(*) FROM dd02l
      WHERE tabname LIKE @lv_pattern
        AND tabclass = 'TRANSP'
        AND as4local = 'A'
      INTO @rv_count.
  ENDMETHOD.

  METHOD list_tables.
    DATA lv_pattern TYPE dd02l-tabname.
    lv_pattern = iv_pattern.
    DATA(lv_total) = count_tables( iv_pattern ).
    line( |  pattern { iv_pattern }: { lv_total } transparent tables| ).
    SELECT tabname FROM dd02l
      WHERE tabname LIKE @lv_pattern
        AND tabclass = 'TRANSP'
        AND as4local = 'A'
      ORDER BY tabname
      INTO TABLE @DATA(lt_names)
      UP TO @iv_max ROWS.
    LOOP AT lt_names INTO DATA(ls_name).
      line( |      { ls_name-tabname }| ).
    ENDLOOP.
    IF lv_total > iv_max.
      line( |      ... { lv_total - iv_max } more (raise iv_max or use SE16)| ).
    ENDIF.
  ENDMETHOD.

  METHOD probe_business_roles.
    section( '5. SAP_BR_* BUSINESS ROLE MENU REPRESENTATION' ).

    SELECT agr_name FROM agr_define
      WHERE agr_name LIKE 'SAP_BR_%'
      ORDER BY agr_name
      INTO TABLE @DATA(lt_roles)
      UP TO 3 ROWS.
    IF lt_roles IS INITIAL.
      line( 'No SAP_BR_* roles found - Fiori business role content may not be' ).
      line( 'installed/activated in this system yet.' ).
      RETURN.
    ENDIF.

    LOOP AT lt_roles INTO DATA(ls_role).
      line( |Role { ls_role-agr_name }:| ).
      " AGR_TCODES: TYPE distinguishes transactions from other menu object
      " kinds. The distinct TYPE values answer how business catalogs appear.
      SELECT type, COUNT(*) AS cnt
        FROM agr_tcodes
        WHERE agr_name = @ls_role-agr_name
        GROUP BY type
        INTO TABLE @DATA(lt_types).
      LOOP AT lt_types INTO DATA(ls_type).
        line( |  AGR_TCODES type '{ ls_type-type }': { ls_type-cnt } entries| ).
      ENDLOOP.
      " AGR_HIER carries the full menu tree; its per-node object typing is
      " the other candidate location for catalog references.
      SELECT COUNT(*) FROM agr_hier WHERE agr_name = @ls_role-agr_name INTO @DATA(lv_hier).
      line( |  AGR_HIER entries: { lv_hier } (inspect one in SE16 to identify the catalog node type)| ).
    ENDLOOP.

    SELECT COUNT(*) FROM agr_define WHERE agr_name LIKE 'SAP_BR_%' INTO @DATA(lv_total).
    line( |Total SAP_BR_* roles in system: { lv_total }| ).
  ENDMETHOD.

  METHOD manual_follow_ups.
    section( '6. MANUAL FOLLOW-UPS THE PROBE CANNOT DECIDE' ).
    line( 'Resolved by run 1 (A4H): USERTCODE user x tcode aggregate EXISTS;' ).
    line( 'collector running; CTS/PFCG/STC read FMs confirmed. See' ).
    line( 'docu/06-s4-integration/api-matrix-a4h.md.' ).
    line( '' ).
    line( '- ST03N retention: ST03N -> Collector & Perf. Database -> Reorganization.' ).
    line( '- /UI2/FLIA: resolve one known WEBGUI target mapping and record the' ).
    line( '  exact application parameter key that carries the tcode' ).
    line( '  (expected: sap-ui2-tcode). Needs a real S/4, not plain A4H.' ).
    line( '- FDM_* OData services: check activation state in /IWFND/MAINT_SERVICE' ).
    line( '  for FDM_SPACE_REPOSITORY_CUST_SRV, FDM_PAGE_REPOSITORY_CUST_SRV,' ).
    line( '  FDM_TRANSPORT_SRV. Needs a real S/4 2023.' ).
    line( '- AGR_HIER: on a real S/4, open one SAP_BR_* role in PFCG, find a' ).
    line( '  business catalog menu node, locate its AGR_HIER/AGR_HIERT rows.' ).
    line( '- ICF deactivation: if section 2 run-2 candidates are all MISSING,' ).
    line( '  read the where-used list of SICF deactivate (CL_ICF_TREE methods).' ).
    line( '- ST01 trace while running this report with the future technical user' ).
    line( '  to build the ZADO_BR_READER authorization list from evidence.' ).
    line( '- IMPORTANT: catalog derivation, spaces/pages and SAP_BR content' ).
    line( '  cannot be validated on plain A4H (no S4CORE). Line up the customer' ).
    line( '  sandbox or an SAP CAL fully-activated S/4HANA 2023 appliance.' ).
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_probe( )->run( ).
