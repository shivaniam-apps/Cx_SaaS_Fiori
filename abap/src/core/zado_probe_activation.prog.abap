REPORT zado_probe_activation LINE-SIZE 255.

"---------------------------------------------------------------------
" AdoptOps activation probe (read-only) - the three S3 open checks.
"
" Answers, against THIS system, what the remaining activation step
" types need before their executors can be written
" (docu/06-s4-integration/api-matrix.md "still manual" items 2 and 4,
" docu/00-overview/road-to-production.md S3):
"   1. Task-list parameters: the STC_TM_* FMs that read a scenario's
"      parameter shape (SAP_GATEWAY_ACTIVATE_ODATA_SERV), plus the
"      gateway-side activation APIs as a direct alternative.
"   2. Spaces/pages write path: /UI2/ FDM classes and FMs, the
"      repository tables (/UI2/STHEAD, /UI2/PGHEAD, /UI2/STPGA) and the
"      transport object types spaces/pages travel with.
"   3. PFCG menu node shape for business catalogs and launchpad spaces:
"      AGR_HIER / AGR_HIERT / AGR_BUFFI field lists and rows of a
"      business role and of a role that already carries a space.
"
" The report only SELECTs. It creates, changes and activates nothing.
" Run via SE38 on RD1 DEV/100 and attach the full list output to the
" API matrix; the S3 executors are written from that output.
"---------------------------------------------------------------------

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_scen FOR FIELD p_scen.
PARAMETERS p_scen TYPE stc_scenario_id DEFAULT 'SAP_GATEWAY_ACTIVATE_ODATA_SERV'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_brole FOR FIELD p_brole.
PARAMETERS p_brole TYPE agr_name DEFAULT 'SAP_BR_AA_ACCOUNTANT'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_srole FOR FIELD p_srole.
PARAMETERS p_srole TYPE agr_name.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_rows FOR FIELD p_rows.
PARAMETERS p_rows TYPE i DEFAULT 8.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_scen  = 'Task-list scenario'.
  c_brole = 'Business role (SAP_BR_*)'.
  c_srole = 'Role with a space in its menu'.
  c_rows  = 'Rows per table dump'.

CLASS lcl_probe DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.
  PRIVATE SECTION.
    METHODS section IMPORTING iv_title TYPE string.
    METHODS line IMPORTING iv_text TYPE string.
    METHODS probe_tasklist_parameters.
    METHODS probe_gateway_activation.
    METHODS probe_spaces_pages.
    METHODS probe_role_menu_nodes.
    METHODS manual_follow_ups.
    METHODS fm_signature IMPORTING iv_funcname TYPE tfdir-funcname.
    METHODS list_functions IMPORTING iv_pattern TYPE string
                                     iv_max     TYPE i DEFAULT 40.
    METHODS list_classes IMPORTING iv_pattern TYPE string
                                   iv_max     TYPE i DEFAULT 40.
    METHODS field_list IMPORTING iv_table TYPE string.
    METHODS class_methods IMPORTING iv_class TYPE string
                                    iv_max   TYPE i DEFAULT 40.
    METHODS probe_round_two.
    METHODS probe_round_three.
    " Generic, dynamic row dump: table name and WHERE clause as strings,
    " so a wrong column or table name is reported, never a syntax error.
    METHODS dump_rows IMPORTING iv_table TYPE string
                                iv_where TYPE string
                                iv_max   TYPE i.
    METHODS count_rows IMPORTING iv_table        TYPE string
                                 iv_where        TYPE string
                       RETURNING VALUE(rv_count) TYPE i.
ENDCLASS.

CLASS lcl_probe IMPLEMENTATION.

  METHOD run.
    line( |AdoptOps activation probe - { sy-sysid }/{ sy-mandt } { sy-datum DATE = ISO } { sy-uzeit TIME = ISO }| ).
    probe_tasklist_parameters( ).
    probe_gateway_activation( ).
    probe_spaces_pages( ).
    probe_role_menu_nodes( ).
    probe_round_two( ).
    probe_round_three( ).
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
    " Long dumps are chunked so nothing is cut at the list width.
    DATA(lv_rest) = iv_text.
    DO.
      IF strlen( lv_rest ) <= 250.
        WRITE: / lv_rest.
        RETURN.
      ENDIF.
      WRITE: / lv_rest(250).
      lv_rest = |      { lv_rest+250 }|.
    ENDDO.
  ENDMETHOD.

  METHOD probe_tasklist_parameters.
    section( |1. TASK-LIST PARAMETERS FOR { p_scen }| ).
    line( 'Candidate readers of a scenario parameter shape (signature = call recipe):' ).
    fm_signature( 'STC_TM_SCENARIO_GET_PARAMETERS' ).
    fm_signature( 'STC_TM_SCENARIO_GET_TASKLIST' ).
    fm_signature( 'STC_TM_SCENARIO_GET_DETAILS' ).
    fm_signature( 'STC_TM_TASKLIST_GET_PARAMETERS' ).
    fm_signature( 'STC_TM_TASK_GET_PARAMETERS' ).
    fm_signature( 'STC_TM_SESSION_GET_PARAMETERS' ).
    fm_signature( 'STC_TM_SESSION_SET_PARAMETERS' ).
    line( 'All STC_TM_SCENARIO* / STC_TM_TASK* / STC_TM_SESSION* function modules:' ).
    list_functions( 'STC_TM_SCENARIO%' ).
    list_functions( 'STC_TM_TASK%' ).
    list_functions( 'STC_TM_SESSION%' ).
    line( 'Scenario/task-list repository rows for the scenario:' ).
    dump_rows( iv_table = 'STCS_SCENARIO'   iv_where = |SCENARIO_ID = '{ p_scen }'| iv_max = p_rows ).
    dump_rows( iv_table = 'STCS_SCENARIOT'  iv_where = |SCENARIO_ID = '{ p_scen }'| iv_max = p_rows ).
    dump_rows( iv_table = 'STCS_SCN_TASK'   iv_where = |SCENARIO_ID = '{ p_scen }'| iv_max = p_rows ).
    line( 'STC tables (DD02L) whose name mentions PARAM - the parameter store:' ).
    dump_rows( iv_table = 'DD02L' iv_where = |TABNAME LIKE 'STC%PARAM%' AND AS4LOCAL = 'A'| iv_max = 40 ).
  ENDMETHOD.

  METHOD probe_gateway_activation.
    section( '1b. GATEWAY SERVICE ACTIVATION - DIRECT API CANDIDATES' ).
    line( 'Function modules with ACTIVAT in /IWFND/ and /IWBEP/:' ).
    list_functions( '/IWFND/%ACTIVAT%' ).
    list_functions( '/IWBEP/%ACTIVAT%' ).
    line( 'Classes with ACTIVAT in /IWFND/ and /IWBEP/:' ).
    list_classes( '/IWFND/%ACTIVAT%' ).
    list_classes( '/IWBEP/%ACTIVAT%' ).
    line( 'Service registration tables (field lists) and a sample FDM row:' ).
    field_list( '/IWFND/I_MED_SRH' ).
    field_list( '/IWFND/C_MGDEAM' ).
    dump_rows( iv_table = '/IWFND/I_MED_SRH' iv_where = |SRV_IDENTIFIER LIKE '%FDM%'| iv_max = p_rows ).
    line( |Registered services total: { count_rows( iv_table = '/IWFND/I_MED_SRH' iv_where = '' ) }| ).
  ENDMETHOD.

  METHOD probe_spaces_pages.
    section( '2. SPACES AND PAGES - WRITE PATH CANDIDATES' ).
    line( '/UI2/ classes for spaces, pages and the FDM repositories:' ).
    list_classes( '/UI2/CL_FDM%' ).
    list_classes( '/UI2/CL_%SPACE%' ).
    list_classes( '/UI2/CL_%PAGE%' ).
    line( '/UI2/ function modules for spaces and pages:' ).
    list_functions( '/UI2/%SPACE%' ).
    list_functions( '/UI2/%PAGE%' ).
    line( 'Repository tables - field lists:' ).
    field_list( '/UI2/STHEAD' ).
    field_list( '/UI2/STHEADT' ).
    field_list( '/UI2/STPGA' ).
    field_list( '/UI2/PGHEAD' ).
    field_list( '/UI2/PGHEADT' ).
    line( |Spaces: { count_rows( iv_table = '/UI2/STHEAD' iv_where = '' ) }, | &&
          |pages: { count_rows( iv_table = '/UI2/PGHEAD' iv_where = '' ) }, | &&
          |space-page assignments: { count_rows( iv_table = '/UI2/STPGA' iv_where = '' ) }| ).
    line( 'Sample rows (customer-namespace first when present):' ).
    dump_rows( iv_table = '/UI2/STHEAD' iv_where = |ID LIKE 'Z%'|  iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/STHEAD' iv_where = ''              iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/STPGA'  iv_where = ''              iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/PGHEAD' iv_where = ''              iv_max = p_rows ).
    line( 'Transport object types (TADIR) - what a space/page/role travels as:' ).
    dump_rows( iv_table = 'OBJH' iv_where = |OBJECTNAME IN ('UIST','UIPG','UIAD','UIPGC','ACGR')| iv_max = 10 ).
    SELECT pgmid, object, COUNT(*) AS cnt
      FROM tadir
      WHERE object IN ('UIST', 'UIPG', 'UIAD', 'ACGR')  "TADIR-OBJECT is CHAR 4; UIPGC is an OBJH name only
      GROUP BY pgmid, object
      INTO TABLE @DATA(lt_tadir).
    LOOP AT lt_tadir INTO DATA(ls_tadir).
      line( |  TADIR { ls_tadir-pgmid } { ls_tadir-object }: { ls_tadir-cnt } entries| ).
    ENDLOOP.
    IF lt_tadir IS INITIAL.
      line( '  TADIR: none of UIST/UIPG/UIAD/UIPGC/ACGR found - check SE03 object types manually.' ).
    ENDIF.
  ENDMETHOD.

  METHOD probe_role_menu_nodes.
    section( '3. PFCG MENU NODE SHAPE - CATALOGS AND SPACES IN AGR_HIER' ).
    line( 'Field lists:' ).
    field_list( 'AGR_HIER' ).
    field_list( 'AGR_HIERT' ).
    field_list( 'AGR_BUFFI' ).
    field_list( 'SMENSAPNEW' ).

    line( |Business role { p_brole } (catalog nodes expected):| ).
    line( |  AGR_HIER rows: { count_rows( iv_table = 'AGR_HIER' iv_where = |AGR_NAME = '{ p_brole }'| ) }| ).
    dump_rows( iv_table = 'AGR_HIER'  iv_where = |AGR_NAME = '{ p_brole }'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_HIERT' iv_where = |AGR_NAME = '{ p_brole }'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = '{ p_brole }'| iv_max = p_rows ).

    IF p_srole IS NOT INITIAL.
      line( |Role with a launchpad space { p_srole } (space node expected):| ).
      dump_rows( iv_table = 'AGR_HIER'  iv_where = |AGR_NAME = '{ p_srole }'| iv_max = p_rows ).
      dump_rows( iv_table = 'AGR_HIERT' iv_where = |AGR_NAME = '{ p_srole }'| iv_max = p_rows ).
      dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = '{ p_srole }'| iv_max = p_rows ).
    ELSE.
      line( 'No space-carrying role given: in PFCG, add a launchpad space to a test' ).
      line( 'role once, then re-run with that role to capture the space node shape.' ).
    ENDIF.

    line( 'Menu writer signature (HIERARCHY_NODES is the expected node carrier):' ).
    fm_signature( 'PRGN_RFC_CREATE_ACTIVITY_GROUP' ).
    fm_signature( 'PRGN_MENU_ADD_NODE' ).
    fm_signature( 'PRGN_MENU_ADD_SPACE' ).
    list_functions( 'PRGN_MENU%' ).
    line( 'Role deletion candidates (ROLLBACK_CREATE_PFCG_ROLE calls the first one present):' ).
    fm_signature( 'PRGN_RFC_DELETE_AGR' ).
    fm_signature( 'PRGN_DELETE_AGR' ).
    fm_signature( 'PRGN_RFC_DELETE_ACTIVITY_GROUP' ).
    " Round 1 (RD1/400, 2026-09-18): the three above are MISSING; this one exists.
    fm_signature( 'PRGN_ACTIVITY_GROUP_DELETE' ).
    list_functions( 'PRGN%DELETE%' ).
    list_functions( '/UI2/%ROLE%' ).
  ENDMETHOD.

  METHOD probe_round_two.
    " Round 2 (written from the RD1/400 output of 2026-09-18): the direct
    " gateway activation API, the FDM space/page API surface, the transport
    " object types of launchpad content, and the role-deletion FM signature.
    " Run in CLIENT 100: spaces, pages and service assignments are
    " client-dependent and were empty in 400.
    section( '3b. ROUND 2 - SIGNATURES BEHIND THE ROUND-1 FINDINGS' ).
    " Row structures of the task-list parameter tables (ET_PARAM_DEF / IT_PARAMETER):
    " the ACTIVATE_ODATA_SERVICE executor fills IT_PARAMETER by component name.
    line( 'Task-list parameter table types and their row structures (DD40L -> DD03L):' ).
    dump_rows( iv_table = 'DD40L' iv_where = |TYPENAME IN ('STCTM_TX_VALUE','STCTM_TX_PARAMETER','STCTM_T_TASK') AND AS4LOCAL = 'A'| iv_max = 5 ).
    field_list( 'STCTM_S_VALUE' ).
    field_list( 'STCTM_S_PARAMETER' ).
    field_list( 'STCTM_SX_PARAMETER' ).
    field_list( 'STCTM_S_TASK' ).
    field_list( 'STC_EXT_CALLER_INFO' ).
    field_list( 'STCTM_S_EXEC_SETTINGS' ).
    line( 'Scenario parameter definitions as the FM returns them (SAP_GATEWAY_ACTIVATE_ODATA_SERV):' ).
    DATA lt_param_def TYPE stctm_tx_parameter.
    DATA lt_param_val TYPE stctm_tx_value.
    DATA lt_return    TYPE bapirettab.
    " Passed initial: its components are recorded by the field list above,
    " not assumed. The language goes in as its declared type (RD1 rejects
    " untyped literals on function-module parameters).
    DATA ls_caller    TYPE stc_ext_caller_info.
    DATA lv_langu     TYPE laiso VALUE 'EN'.
    CALL FUNCTION 'STC_TM_SCENARIO_GET_PARAMETERS'
      EXPORTING
        i_scenario_id  = p_scen
        i_language     = lv_langu
        is_caller_info = ls_caller
      IMPORTING
        et_param_def   = lt_param_def
        et_parameter   = lt_param_val
      TABLES
        et_return      = lt_return
      EXCEPTIONS
        OTHERS         = 1.
    IF sy-subrc <> 0.
      line( |  STC_TM_SCENARIO_GET_PARAMETERS failed, sy-subrc { sy-subrc }| ).
    ELSE.
      line( |  { lines( lt_param_def ) } parameter definition(s), { lines( lt_param_val ) } value row(s), { lines( lt_return ) } message(s)| ).
      LOOP AT lt_param_def ASSIGNING FIELD-SYMBOL(<ls_def>).
        DATA(lo_def) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_data( <ls_def> ) ).
        DATA lv_def_text TYPE string.
        CLEAR lv_def_text.
        LOOP AT lo_def->components INTO DATA(ls_def_comp).
          ASSIGN COMPONENT ls_def_comp-name OF STRUCTURE <ls_def> TO FIELD-SYMBOL(<lv_def_val>).
          IF sy-subrc = 0 AND <lv_def_val> IS NOT INITIAL.
            lv_def_text = |{ lv_def_text } { ls_def_comp-name }=[{ <lv_def_val> }]|.
          ENDIF.
        ENDLOOP.
        line( |     DEF{ lv_def_text }| ).
      ENDLOOP.
      LOOP AT lt_return INTO DATA(ls_ret).
        line( |     MSG { ls_ret-type } { ls_ret-id } { ls_ret-number } { ls_ret-message }| ).
      ENDLOOP.
    ENDIF.
    line( 'Direct gateway activation (replaces the task list when usable):' ).
    fm_signature( '/IWFND/FM_ACTIVATE_SERVICE' ).
    class_methods( '/IWFND/CL_MGW_ACTIVATION_API' ).
    class_methods( '/IWFND/CL_MED_REM_ACTIVATION' ).
    line( 'Space / page API surface (public methods and parameters):' ).
    class_methods( '/UI2/CL_FDM_SPACE_API' ).
    class_methods( '/UI2/CL_FDM_SPACE_API_FACTORY' ).
    class_methods( '/UI2/CL_FDM_PAGE_API' ).
    class_methods( '/UI2/CL_FDM_PAGE_API_FACTORY' ).
    class_methods( '/UI2/CL_FDM_SPACE_CTS_ACCESS' ).
    class_methods( '/UI2/CL_FDM_PAGE_CTS_ACCESS' ).
    class_methods( '/UI2/CL_FDM_SPACE_TRANS_OBJECT' ).
    line( 'Role deletion (round 1: PRGN_RFC_DELETE_AGR / PRGN_DELETE_AGR / PRGN_RFC_DELETE_ACTIVITY_GROUP are MISSING):' ).
    fm_signature( 'PRGN_ACTIVITY_GROUP_DELETE' ).
    fm_signature( 'PRGN_RFC_DELETE_DERIVATION' ).
    line( 'Transport object types of launchpad content (TADIR counts per UI* object type):' ).
    SELECT object, COUNT(*) AS cnt FROM tadir
      WHERE pgmid = 'R3TR' AND object LIKE 'UI%'
      GROUP BY object ORDER BY object
      INTO TABLE @DATA(lt_ui_objects).
    LOOP AT lt_ui_objects INTO DATA(ls_ui).
      line( |  TADIR R3TR { ls_ui-object }: { ls_ui-cnt } entries| ).
    ENDLOOP.
    dump_rows( iv_table = 'OBJH' iv_where = |OBJECTNAME LIKE 'UI%'| iv_max = 30 ).
    dump_rows( iv_table = 'OBJT' iv_where = |OBJECTNAME LIKE 'UI%' AND LANGUAGE = 'E'| iv_max = 30 ).
    line( |Spaces in THIS client: { count_rows( iv_table = '/UI2/STHEAD' iv_where = '' ) } (0 in client 400 - re-run in 100)| ).
    dump_rows( iv_table = '/UI2/STHEAD'  iv_where = '' iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/STHEADT' iv_where = |LANGU = '{ sy-langu }'| iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/STPGA'   iv_where = '' iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/PGHEAD'  iv_where = '' iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/PGHEADT' iv_where = |LANGU = '{ sy-langu }'| iv_max = p_rows ).
    " Round 1 answered the node shape: REPORTTYPE OT with REPORT = CAT_PROVIDER /
    " GROUP_PROVIDER / SPACE_PROVIDER and the id in AGR_BUFFI-URL. How PRGN
    " receives that URL is the remaining question: SMENSAPNEW has no URL field.
    line( 'Menu URL carrier candidates (SMENSAPNEW has no URL column):' ).
    field_list( 'SMENCUST' ).
    field_list( 'AGR_BUFFI' ).
    list_functions( 'PRGN_RFC%' ).
    line( 'Any Z role that already carries a space or catalog node (learn the write result):' ).
    dump_rows( iv_table = 'AGR_HIER'  iv_where = |AGR_NAME LIKE 'Z%' AND REPORTTYPE = 'OT'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME LIKE 'Z%'| iv_max = p_rows ).
  ENDMETHOD.

  METHOD probe_round_three.
    " Round 3 (from the RD1/100 round-2 output of 2026-09-18): the FDM API
    " classes are factories for INTERFACES - the methods live there; the
    " task-list value row type is STCTM_SX_VALUE; PRGN_RFC_CREATE_ACTIVITY_GROUP
    " cannot carry the AGR_BUFFI URL of an OT node, so the PFCG-side writers
    " for catalog / space nodes are recorded; ZFIORI_MASTER_DEV_ROLE is a
    " customer role that already carries catalog + SERVICE nodes.
    section( '3c. ROUND 3 - INTERFACE METHODS, VALUE ROW TYPE, PFCG NODE WRITERS' ).
    line( 'Space / page API interfaces (the factories return these):' ).
    class_methods( '/UI2/IF_FDM_SPACE_API' ).
    class_methods( '/UI2/IF_FDM_PAGE_API' ).
    class_methods( '/UI2/IF_FDM_SPACE_CTS_ACCESS' ).
    class_methods( '/UI2/IF_FDM_PAGE_CTS_ACCESS' ).
    line( 'Structures the two APIs exchange:' ).
    list_classes( '/UI2/IF_FDM%' ).
    dump_rows( iv_table = 'DD40L' iv_where = |TYPENAME LIKE '/UI2/FDM%SPACE%' AND AS4LOCAL = 'A'| iv_max = 12 ).
    dump_rows( iv_table = 'DD40L' iv_where = |TYPENAME LIKE '/UI2/FDM%PAGE%' AND AS4LOCAL = 'A'| iv_max = 12 ).
    dump_rows( iv_table = 'DD02L' iv_where = |TABNAME LIKE '/UI2/FDM%SPACE%' AND AS4LOCAL = 'A' AND TABCLASS = 'INTTAB'| iv_max = 12 ).
    dump_rows( iv_table = 'DD02L' iv_where = |TABNAME LIKE '/UI2/FDM%PAGE%' AND AS4LOCAL = 'A' AND TABCLASS = 'INTTAB'| iv_max = 12 ).
    line( 'Customizing layer (client-dependent) of spaces and pages:' ).
    field_list( '/UI2/STHEADC' ).
    field_list( '/UI2/STPGAC' ).
    field_list( '/UI2/PGHEADC' ).
    line( |  /UI2/STHEADC { count_rows( iv_table = '/UI2/STHEADC' iv_where = '' ) }, /UI2/PGHEADC { count_rows( iv_table = '/UI2/PGHEADC' iv_where = '' ) }, /UI2/STPGAC { count_rows( iv_table = '/UI2/STPGAC' iv_where = '' ) }| ).
    line( 'Task-list value row type:' ).
    field_list( 'STCTM_SX_VALUE' ).
    line( 'PFCG-side writers for catalog / group / space nodes:' ).
    fm_signature( '/UI2/SPACE_PFCG_CREATE' ).
    fm_signature( '/UI2/SPACE_PFCG_CHANGE' ).
    fm_signature( '/UI2/SPACE_PFCG_EXECUTE' ).
    fm_signature( '/UI2/CAT_PROV_PFCG_PAGES_INIT' ).
    fm_signature( '/UI2/CAT_PROV_PFCG_PAGES_CHECK' ).
    fm_signature( 'PRGN_RFC_ADD_TRANSACTION' ).
    list_functions( 'PRGN%NODE%' ).
    list_functions( 'PRGN%FOLDER%' ).
    list_functions( 'PRGN%URL%' ).
    list_functions( 'PRGN%HIER%' ).
    list_functions( 'PRGN%CATALOG%' ).
    list_classes( 'CL_PFCG%MENU%' ).
    list_classes( 'CL_PRGN%MENU%' ).
    list_classes( 'CL_PFCG%PROVIDER%' ).
    list_classes( '/UI2/CL%PFCG%' ).
    line( 'A customer role that already carries catalog and app nodes (the write result to reproduce):' ).
    dump_rows( iv_table = 'AGR_HIER'  iv_where = |AGR_NAME = 'ZFIORI_MASTER_DEV_ROLE'| iv_max = 12 ).
    dump_rows( iv_table = 'AGR_HIERT' iv_where = |AGR_NAME = 'ZFIORI_MASTER_DEV_ROLE' AND SPRAS = '{ sy-langu }'| iv_max = 12 ).
    dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = 'ZFIORI_MASTER_DEV_ROLE'| iv_max = 12 ).
    dump_rows( iv_table = 'AGR_TCODES' iv_where = |AGR_NAME = 'ZFIORI_MASTER_DEV_ROLE'| iv_max = 12 ).
  ENDMETHOD.

  METHOD manual_follow_ups.
    section( '4. WHAT TO DO WITH THIS OUTPUT' ).
    line( '- Section 1: pick the FM that returns the scenario parameters; its' ).
    line( '  exporting/tables parameters name the IT_PARAMETER shape for' ).
    line( '  STC_TM_SESSION_BEGIN. If none exists, run the scenario once in STC01' ).
    line( '  with SAP_GATEWAY_ACTIVATE_ODATA_SERV and read the parameter table' ).
    line( '  from the STC%PARAM% table listed above.' ).
    line( '- Section 1b: if a /IWFND/ activation FM/class exists, it replaces the' ).
    line( '  task list for ACTIVATE_ODATA_SERVICE (one FM per service, faster).' ).
    line( '- Section 2: the /UI2/CL_FDM* class list is the space/page API surface;' ).
    line( '  the TADIR counts confirm the object types for APPEND_TO_TRANSPORT.' ).
    line( '- Section 3: the AGR_HIER rows show the node type/id columns that' ).
    line( '  ADD_SPACE_TO_ROLE and ADD_CATALOG_TO_ROLE must write (HIERARCHY_NODES).' ).
    line( '- Attach the full output to docu/06-s4-integration/api-matrix.md.' ).
  ENDMETHOD.


  METHOD class_methods.
    DATA lv_class TYPE seoclsname.
    lv_class = iv_class.
    SELECT SINGLE clsname FROM seoclass WHERE clsname = @lv_class INTO @DATA(lv_found).
    IF sy-subrc <> 0.
      line( |  { iv_class }: MISSING| ).
      RETURN.
    ENDIF.
    " CMPTYPE 1 = method; EXPOSURE 2 = public (SEOCOMPODF).
    SELECT c~cmpname, d~exposure
      FROM seocompo AS c
      INNER JOIN seocompodf AS d ON d~clsname = c~clsname AND d~cmpname = c~cmpname
      WHERE c~clsname = @lv_class AND c~cmptype = 1
      ORDER BY d~exposure DESCENDING, c~cmpname
      INTO TABLE @DATA(lt_methods)
      UP TO @iv_max ROWS.
    line( |  { iv_class }: { lines( lt_methods ) } method(s) listed| ).
    LOOP AT lt_methods INTO DATA(ls_method).
      SELECT sconame, pardecltyp, typtype, type
        FROM seosubcodf
        WHERE clsname = @lv_class AND cmpname = @ls_method-cmpname
        ORDER BY sconame
        INTO TABLE @DATA(lt_params).
      DATA lv_text TYPE string.
      CLEAR lv_text.
      LOOP AT lt_params INTO DATA(ls_param).
        lv_text = |{ lv_text } { ls_param-sconame }:{ ls_param-pardecltyp }:{ ls_param-type }|.
      ENDLOOP.
      " No COND # inside a string template: there is no type to infer from.
      DATA(lv_exposure) = COND string( WHEN ls_method-exposure = 2 THEN `PUBLIC ` ELSE `other  ` ).
      line( |     { lv_exposure }{ ls_method-cmpname }{ lv_text }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD fm_signature.
    SELECT SINGLE funcname FROM tfdir WHERE funcname = @iv_funcname INTO @DATA(lv_found).
    IF sy-subrc <> 0.
      line( |  { iv_funcname }: MISSING| ).
      RETURN.
    ENDIF.
    line( |  { iv_funcname }: exists| ).
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

  METHOD list_functions.
    DATA lv_pattern TYPE tfdir-funcname.
    lv_pattern = iv_pattern.
    SELECT funcname FROM tfdir
      WHERE funcname LIKE @lv_pattern
      ORDER BY funcname
      INTO TABLE @DATA(lt_names)
      UP TO @iv_max ROWS.
    IF lt_names IS INITIAL.
      line( |  { iv_pattern }: no function modules| ).
      RETURN.
    ENDIF.
    LOOP AT lt_names INTO DATA(ls_name).
      line( |  FM { ls_name-funcname }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD list_classes.
    DATA lv_pattern TYPE seoclsname.
    lv_pattern = iv_pattern.
    SELECT clsname FROM seoclass
      WHERE clsname LIKE @lv_pattern
      ORDER BY clsname
      INTO TABLE @DATA(lt_names)
      UP TO @iv_max ROWS.
    IF lt_names IS INITIAL.
      line( |  { iv_pattern }: no classes/interfaces| ).
      RETURN.
    ENDIF.
    LOOP AT lt_names INTO DATA(ls_name).
      line( |  CLASS { ls_name-clsname }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD field_list.
    DATA lv_tabname TYPE dd03l-tabname.
    lv_tabname = iv_table.
    SELECT fieldname, rollname, position
      FROM dd03l
      WHERE tabname  = @lv_tabname
        AND as4local = 'A'
      ORDER BY position
      INTO TABLE @DATA(lt_fields).
    IF lt_fields IS INITIAL.
      line( |  { iv_table }: no DD03L fields (table missing on this release?)| ).
      RETURN.
    ENDIF.
    DATA lv_text TYPE string.
    CLEAR lv_text.
    LOOP AT lt_fields INTO DATA(ls_field).
      lv_text = |{ lv_text } { ls_field-fieldname }({ ls_field-rollname })|.
    ENDLOOP.
    line( |  { iv_table }:{ lv_text }| ).
  ENDMETHOD.

  METHOD count_rows.
    TRY.
        SELECT COUNT(*) FROM (iv_table) WHERE (iv_where) INTO @rv_count.
      CATCH cx_sy_dynamic_osql_error.
        rv_count = -1.
    ENDTRY.
  ENDMETHOD.

  METHOD dump_rows.
    DATA lr_table TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    TRY.
        CREATE DATA lr_table TYPE STANDARD TABLE OF (iv_table).
        ASSIGN lr_table->* TO <lt_rows>.
        SELECT * FROM (iv_table) WHERE (iv_where)
          INTO TABLE @<lt_rows>
          UP TO @iv_max ROWS.
      CATCH cx_sy_dynamic_osql_error cx_sy_create_data_error INTO DATA(lx_error).
        line( |  { iv_table } [{ iv_where }]: not readable - { lx_error->get_text( ) }| ).
        RETURN.
    ENDTRY.
    IF <lt_rows> IS INITIAL.
      line( |  { iv_table } [{ iv_where }]: no rows| ).
      RETURN.
    ENDIF.
    line( |  { iv_table } [{ iv_where }]: { lines( <lt_rows> ) } row(s)| ).
    DATA(lo_struct) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_name( iv_table ) ).
    LOOP AT <lt_rows> ASSIGNING FIELD-SYMBOL(<ls_row>).
      DATA lv_text TYPE string.
      CLEAR lv_text.
      LOOP AT lo_struct->components INTO DATA(ls_comp).
        IF ls_comp-name = 'MANDT'.
          CONTINUE.
        ENDIF.
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv_value>).
        IF sy-subrc <> 0 OR <lv_value> IS INITIAL.
          CONTINUE.
        ENDIF.
        IF cl_abap_typedescr=>describe_by_data( <lv_value> )->kind <> cl_abap_typedescr=>kind_elem.
          CONTINUE.
        ENDIF.
        lv_text = |{ lv_text } { ls_comp-name }={ <lv_value> }|.
      ENDLOOP.
      line( |     { lv_text }| ).
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_probe( )->run( ).
