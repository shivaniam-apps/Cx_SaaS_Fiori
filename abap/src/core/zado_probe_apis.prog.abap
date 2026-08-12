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

    line( 'ICF activation:' ).
    fm_signature( 'HTTP_ACTIVATE_NODE' ).
    fm_signature( 'HTTP_DEACTIVATE_NODE' ).

    line( 'PFCG / roles:' ).
    fm_signature( 'PRGN_RFC_CREATE_AGR_MULTIPLE' ).
    fm_signature( 'PRGN_RFC_CREATE_ACTIVITY_GROUP' ).
    fm_signature( 'PRGN_READ_ROLE_MENU' ).
    fm_signature( 'PRGN_AUTO_GENERATE_PROFILE_NEW' ).
    fm_signature( 'BAPI_USER_ACTGROUPS_ASSIGN' ).
    fm_signature( 'PFCG_TIME_DEPENDENCY' ).

    line( 'Transport (CTS):' ).
    fm_signature( 'TR_INSERT_NEW_COMM' ).
    fm_signature( 'TRINT_INSERT_NEW_COMM' ).
    fm_signature( 'TR_APPEND_TO_COMM_OBJS_KEYS' ).
    fm_signature( 'TR_OBJECTS_CHECK' ).
    fm_signature( 'TR_READ_COMM' ).
    fm_signature( 'TR_RELEASE_REQUEST' ).
    fm_signature( 'TRINT_RELEASE_REQUEST' ).

    line( 'Task manager (STC01):' ).
    fm_signature( 'STC_TM_GET_SCENARIO_LIST' ).
    fm_signature( 'STC_TM_SCENARIO_GET_TASKLIST' ).
    fm_signature( 'STC_TM_SCENARIO_GET_PARAMETERS' ).
    fm_signature( 'STC_TM_GET_TEMPLATE_LIST' ).
    fm_signature( 'STC_TM_GET_SESSION_LIST' ).
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
    line( 'Launchpad content and spaces/pages:' ).
    list_tables( '/UI2/%' ).
    line( 'IAM apps / business catalogs:' ).
    list_tables( '%IAM%APP%' ).
    line( 'Spaces/pages repository (FDM):' ).
    list_tables( 'FDM%' ).
    line( 'Task manager:' ).
    list_tables( 'STC%' ).
    line( 'ICF:' ).
    list_tables( 'ICFSERVICE%' ).
    list_tables( 'ICFACTIVE%' ).
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
    line( '- SWNC_COLLECTOR_GET_AGGREGATES: from section 2, note which TABLES' ).
    line( '  parameters carry the transaction profile vs the user profile, and' ).
    line( '  whether a combined user x tcode aggregate exists. If not, per-user' ).
    line( '  per-tcode detail must come from STAD sampling (product constraint).' ).
    line( '- ST03N retention: ST03N -> Collector & Perf. Database -> Reorganization.' ).
    line( '- STC01: list scenarios, confirm exact names of SAP_FIORI_FOUNDATION_S4,' ).
    line( '  SAP_FIORI_LAUNCHPAD_INIT_SETUP, SAP_FIORI_CONTENT_ACTIVATION (or the' ).
    line( '  release-specific equivalents).' ).
    line( '- /UI2/FLIA: resolve one known WEBGUI target mapping and record the' ).
    line( '  exact application parameter key that carries the tcode' ).
    line( '  (expected: sap-ui2-tcode).' ).
    line( '- FDM_* OData services: check activation state in /IWFND/MAINT_SERVICE' ).
    line( '  for FDM_SPACE_REPOSITORY_CUST_SRV, FDM_PAGE_REPOSITORY_CUST_SRV,' ).
    line( '  FDM_TRANSPORT_SRV.' ).
    line( '- AGR_HIER: open one SAP_BR_* role in PFCG, find a business catalog' ).
    line( '  menu node, then locate its row in AGR_HIER/AGR_HIERT to record the' ).
    line( '  node type and catalog id columns.' ).
    line( '- ST01 trace while running this report with the future technical user' ).
    line( '  to build the ZADO_BR_READER authorization list from evidence.' ).
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_probe( )->run( ).
