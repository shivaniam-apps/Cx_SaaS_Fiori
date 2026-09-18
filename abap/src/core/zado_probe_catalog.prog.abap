REPORT zado_probe_catalog LINE-SIZE 255.

"---------------------------------------------------------------------
" AdoptOps catalog probe (read-only) - the S9 part 2 open checks.
"
" Records, against THIS system, the shape of the tables the backend
" catalog readers (ZADO_CATALOG_SRV: CatalogApps, LaunchpadContent)
" will be written from:
"   1. IAM app repository: field lists and sample rows of /IAM/I_APPL,
"      /IAM/I_APPL_T and every other %IAM% table (app id, UI5 component,
"      BSP application, semantic object/action, catalog assignment).
"   2. UI5 apps as the system holds them: TADIR WAPA (BSP applications)
"      and their ICF nodes under /sap/bc/ui5_ui5/sap/ (ICFSERVICE.ICF_NOACT
"      is the activation state, verified on RD1).
"   3. OData service registry (/IWFND/I_MED_SRH and friends): which
"      services exist and are active, to fill ServiceActivationState.
"   4. Launchpad content: /UI2/ catalog, space and page tables with
"      sample rows, the technical/business catalog link.
"   5. Business catalog -> app link in PFCG: AGR_HIER / AGR_BUFFI rows
"      of one SAP_BR_* role (node type, catalog id, URL).
"
" The report only SELECTs. It creates, changes and activates nothing.
" Run via SE38 on RD1 DEV/100 (client 100 has the catalog content) and
" attach the full list output to docu/08; the readers are written from
" that output. PO-1 (mapping source) is a separate question - this probe
" reads the customer's own system only.
"---------------------------------------------------------------------

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_brole FOR FIELD p_brole.
PARAMETERS p_brole TYPE agr_name DEFAULT 'SAP_BR_INTERNAL_SALES_REP'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_bsp FOR FIELD p_bsp.
PARAMETERS p_bsp TYPE c LENGTH 40 DEFAULT 'SD_SO_MANAGES1'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_rows FOR FIELD p_rows.
PARAMETERS p_rows TYPE i DEFAULT 8.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_brole = 'Business role (SAP_BR_*)'.
  c_bsp   = 'A known UI5 BSP application'.
  c_rows  = 'Rows per table dump'.

CLASS lcl_probe DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.
  PRIVATE SECTION.
    METHODS section IMPORTING iv_title TYPE string.
    METHODS line IMPORTING iv_text TYPE string.
    METHODS probe_iam_repository.
    METHODS probe_ui5_apps.
    METHODS probe_odata_registry.
    METHODS probe_launchpad_content.
    METHODS probe_role_catalog_link.
    METHODS manual_follow_ups.
    METHODS list_tables IMPORTING iv_pattern TYPE string
                                  iv_max     TYPE i DEFAULT 60.
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
    line( |AdoptOps catalog probe - { sy-sysid }/{ sy-mandt } { sy-datum DATE = ISO } { sy-uzeit TIME = ISO }| ).
    probe_iam_repository( ).
    probe_ui5_apps( ).
    probe_odata_registry( ).
    probe_launchpad_content( ).
    probe_role_catalog_link( ).
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

  METHOD probe_iam_repository.
    section( '1. IAM APP REPOSITORY (/IAM/I_APPL*) - FIORI ID, UI5 COMPONENT, BSP, CATALOGS' ).
    list_tables( '/IAM/%' ).
    field_list( '/IAM/I_APPL' ).
    field_list( '/IAM/I_APPL_T' ).
    line( |/IAM/I_APPL rows: { count_rows( iv_table = '/IAM/I_APPL' iv_where = '' ) }| ).
    dump_rows( iv_table = '/IAM/I_APPL'   iv_where = '' iv_max = p_rows ).
    dump_rows( iv_table = '/IAM/I_APPL_T' iv_where = |LANGU = '{ sy-langu }'| iv_max = p_rows ).
    " Every other IAM table with a field list: catalog and group assignments
    " live somewhere in this family on S/4HANA 2023.
    DATA lv_pattern TYPE dd02l-tabname VALUE '/IAM/I_%'.
    SELECT tabname FROM dd02l
      WHERE tabname LIKE @lv_pattern AND tabclass = 'TRANSP' AND as4local = 'A'
      ORDER BY tabname INTO TABLE @DATA(lt_iam) UP TO 40 ROWS.
    LOOP AT lt_iam INTO DATA(ls_iam).
      field_list( CONV string( ls_iam-tabname ) ).
    ENDLOOP.
  ENDMETHOD.

  METHOD probe_ui5_apps.
    section( '2. UI5 APPS: TADIR WAPA (BSP APPLICATIONS) AND THEIR ICF NODES' ).
    line( |TADIR WAPA objects: { count_rows( iv_table = 'TADIR' iv_where = |PGMID = 'R3TR' AND OBJECT = 'WAPA'| ) }| ).
    dump_rows( iv_table = 'TADIR' iv_where = |PGMID = 'R3TR' AND OBJECT = 'WAPA' AND OBJ_NAME LIKE 'SD_%'| iv_max = p_rows ).
    line( |ICF nodes under ui5_ui5: { count_rows( iv_table = 'ICFSERVICE' iv_where = |ICFPARGUID IN ( SELECT ICFNODGUID FROM ICFSERVICE WHERE ICF_NAME = 'sap' )| ) } (parent guid join - may be -1 if the subquery is refused; then read by name below)| ).
    field_list( 'ICFSERVICE' ).
    dump_rows( iv_table = 'ICFSERVICE' iv_where = |ICF_NAME = '{ to_lower( p_bsp ) }'| iv_max = p_rows ).
    dump_rows( iv_table = 'ICFSERVICE' iv_where = |ICF_NAME = 'ui5_ui5'| iv_max = p_rows ).
    " O2 / WAPA descriptors: application texts and the UI5 component name.
    list_tables( 'O2APPL%' ).
    field_list( 'O2APPL' ).
    field_list( 'O2APPLT' ).
    dump_rows( iv_table = 'O2APPL'  iv_where = |APPLNAME = '{ p_bsp }'| iv_max = p_rows ).
    dump_rows( iv_table = 'O2APPLT' iv_where = |APPLNAME = '{ p_bsp }'| iv_max = p_rows ).
  ENDMETHOD.

  METHOD probe_odata_registry.
    section( '3. ODATA SERVICE REGISTRY (/IWFND/*) - SERVICE ACTIVATION STATE' ).
    list_tables( '/IWFND/I_MED%' ).
    list_tables( '/IWFND/C_%' ).
    field_list( '/IWFND/I_MED_SRH' ).
    field_list( '/IWFND/I_MED_SRT' ).
    field_list( '/IWFND/C_MGDEAM' ).
    dump_rows( iv_table = '/IWFND/I_MED_SRH' iv_where = |SRV_IDENTIFIER LIKE 'SD_%'| iv_max = p_rows ).
    dump_rows( iv_table = '/IWFND/C_MGDEAM' iv_where = '' iv_max = p_rows ).
    " OData V4 groups and services (S/4HANA 2023 publishes V4 through /IWFND/V4).
    list_tables( '/IWFND/V4%' ).
    list_tables( '/IWBEP/I_V4%' ).
  ENDMETHOD.

  METHOD probe_launchpad_content.
    section( '4. LAUNCHPAD CONTENT: CATALOGS, SPACES, PAGES (/UI2/*)' ).
    list_tables( '/UI2/CATALOG%' ).
    list_tables( '/UI2/CDM%' ).
    list_tables( '/UI2/ST%' ).
    list_tables( '/UI2/PG%' ).
    field_list( '/UI2/STHEAD' ).
    field_list( '/UI2/STHEADT' ).
    field_list( '/UI2/STPGA' ).
    field_list( '/UI2/PGHEAD' ).
    field_list( '/UI2/PGHEADT' ).
    line( |Spaces: { count_rows( iv_table = '/UI2/STHEAD' iv_where = '' ) }, pages: { count_rows( iv_table = '/UI2/PGHEAD' iv_where = '' ) }, assignments: { count_rows( iv_table = '/UI2/STPGA' iv_where = '' ) }| ).
    dump_rows( iv_table = '/UI2/STHEAD'  iv_where = '' iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/STHEADT' iv_where = |LANGU = '{ sy-langu }'| iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/STPGA'   iv_where = '' iv_max = p_rows ).
    dump_rows( iv_table = '/UI2/PGHEAD'  iv_where = '' iv_max = p_rows ).
    " Technical / business catalogs of the CDM3 repository.
    list_tables( '/UI2/FLPD%' ).
    list_tables( '/UI2/FLP%' ).
    list_tables( '/UI2/TC%' ).
    list_tables( '/UI2/BC%' ).
  ENDMETHOD.

  METHOD probe_role_catalog_link.
    section( '5. BUSINESS ROLE -> CATALOG LINK IN PFCG (AGR_HIER / AGR_BUFFI)' ).
    field_list( 'AGR_HIER' ).
    field_list( 'AGR_HIERT' ).
    field_list( 'AGR_BUFFI' ).
    line( |{ p_brole }: AGR_HIER { count_rows( iv_table = 'AGR_HIER' iv_where = |AGR_NAME = '{ p_brole }'| ) }, AGR_BUFFI { count_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = '{ p_brole }'| ) }| ).
    dump_rows( iv_table = 'AGR_HIER'  iv_where = |AGR_NAME = '{ p_brole }'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_HIERT' iv_where = |AGR_NAME = '{ p_brole }' AND SPRAS = '{ sy-langu }'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = '{ p_brole }'| iv_max = p_rows ).
  ENDMETHOD.

  METHOD probe_round_two.
    " Round 2 (written from the RD1/400 output of 2026-09-18). Round 1 showed
    " that /IAM/ is Issue and Activity Management, not the Fiori app
    " repository; the app id (F1765) appears in AGR_BUFFI as an OTSERVICE
    " node and TADIR holds 18664 UIAD app descriptor items. This section
    " looks for the app-id tables behind UIAD, the CDM3/FLP content tables,
    " the ICF name case, and the V4 service registry. Run in CLIENT 100.
    section( '7. ROUND 2 - APP DESCRIPTORS, FLP CONTENT, ICF CASE, V4 SERVICES' ).
    line( 'TADIR UIAD app descriptor items (the id is the OBJ_NAME):' ).
    dump_rows( iv_table = 'TADIR' iv_where = |PGMID = 'R3TR' AND OBJECT = 'UIAD'| iv_max = p_rows ).
    dump_rows( iv_table = 'TADIR' iv_where = |PGMID = 'R3TR' AND OBJECT = 'UIAD' AND OBJ_NAME LIKE '%F1765%'| iv_max = p_rows ).
    dump_rows( iv_table = 'TADIR' iv_where = |PGMID = 'R3TR' AND OBJECT = 'UIAD' AND OBJ_NAME LIKE '%SD_SO%'| iv_max = p_rows ).
    line( 'TADIR object types UI* (counts):' ).
    SELECT object, COUNT(*) AS cnt FROM tadir
      WHERE pgmid = 'R3TR' AND object LIKE 'UI%'
      GROUP BY object ORDER BY object
      INTO TABLE @DATA(lt_ui_objects).
    LOOP AT lt_ui_objects INTO DATA(ls_ui).
      line( |  TADIR R3TR { ls_ui-object }: { ls_ui-cnt } entries| ).
    ENDLOOP.
    dump_rows( iv_table = 'OBJT' iv_where = |OBJECTNAME LIKE 'UI%' AND LANGUAGE = 'E'| iv_max = 30 ).
    line( 'FLP content tables (app descriptors, catalogs, target mappings):' ).
    list_tables( '/UI2/FLPRT%' ).
    field_list( '/UI2/FLPRT' ).
    field_list( '/UI2/FLPRTC' ).
    field_list( '/UI2/FLPRTSDEF' ).
    dump_rows( iv_table = '/UI2/FLPRT' iv_where = '' iv_max = p_rows ).
    list_tables( '/UI2/PB%' ).
    list_tables( '/UI2/CHIP%' ).
    field_list( '/UI2/CHIP_CHDR' ).
    field_list( '/UI2/PB_C_PAGE' ).
    field_list( '/UI2/PB_C_PAGET' ).
    dump_rows( iv_table = '/UI2/PB_C_PAGE' iv_where = |PAGE_ID LIKE 'SAP_SD%'| iv_max = p_rows ).
    list_tables( '/UI2/CDM3%' ).
    field_list( '/UI2/CDM3_CCNSTA' ).
    field_list( '/UI2/CDM3_CCNTGT' ).
    dump_rows( iv_table = '/UI2/CDM3_CCNSTA' iv_where = '' iv_max = p_rows ).
    line( 'Business catalog / app ids as PFCG references them, across all SAP_BR roles:' ).
    line( |  OTSERVICE app nodes: { count_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME LIKE 'SAP_BR%' AND URL LIKE 'OTSERVICE%'| ) }| ).
    line( |  X-SAP-UI2-CATALOGPAGE nodes: { count_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME LIKE 'SAP_BR%' AND URL LIKE 'X-SAP-UI2-CATALOGPAGE%'| ) }| ).
    line( |  sap-ui2-group nodes: { count_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME LIKE 'SAP_BR%' AND URL LIKE 'sap-ui2-group%'| ) }| ).
    line( |  SPACE_PROVIDER nodes: { count_rows( iv_table = 'AGR_HIER' iv_where = |AGR_NAME LIKE 'SAP_BR%' AND REPORT = 'SPACE_PROVIDER'| ) }| ).
    dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = '{ p_brole }' AND URL LIKE 'X-SAP-UI2-CATALOGPAGE%'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_BUFFI' iv_where = |AGR_NAME = '{ p_brole }' AND URL LIKE 'OTSERVICE%'| iv_max = 3 ).
    line( 'ICF node name case (round 1 found no row for the lower-case BSP name):' ).
    dump_rows( iv_table = 'ICFSERVICE' iv_where = |ICF_NAME = '{ to_upper( p_bsp ) }'| iv_max = 3 ).
    dump_rows( iv_table = 'ICFSERVICE' iv_where = |ICF_NAME LIKE '%UI5_UI5%' OR ICF_NAME LIKE '%ui5_ui5%'| iv_max = 3 ).
    dump_rows( iv_table = 'ICFSERVICE' iv_where = |ICF_NAME LIKE '%BC%' AND ICF_NAME NOT LIKE '%_%'| iv_max = 3 ).
    line( |  ICFSERVICE rows total: { count_rows( iv_table = 'ICFSERVICE' iv_where = '' ) }| ).
    line( 'OData V4 service registry:' ).
    field_list( '/IWBEP/I_V4_MSRV' ).
    field_list( '/IWBEP/I_V4_MSGR' ).
    dump_rows( iv_table = '/IWBEP/I_V4_MSRV' iv_where = |SERVICE_ID LIKE 'ZADO%'| iv_max = p_rows ).
    line( |  V2 services active in this client (/IWFND/C_MGDEAM): { count_rows( iv_table = '/IWFND/C_MGDEAM' iv_where = '' ) } (8 in client 400)| ).
    dump_rows( iv_table = '/IWFND/I_MED_SRH' iv_where = |SRV_IDENTIFIER LIKE 'SD_SO%' OR SRV_IDENTIFIER LIKE 'C_SALESORDER%'| iv_max = p_rows ).
  ENDMETHOD.

  METHOD probe_round_three.
    " Round 3 (from the RD1/100 round-2 output of 2026-09-18). UIAD names are
    " GUIDs, so the app id does not come from TADIR. PFCG carries it:
    " CAT_PROVIDER folder (catalog id in AGR_BUFFI-URL) -> child SERVICE nodes
    " 'OTSERVICE <FioriId> TR'. Open: app id -> BSP / OData services. Two
    " candidates: the SU22 data of the app id (USOBT/USOBHASH, S_SERVICE
    " values) and the classic page-builder tables (/UI2/PB_C_*: catalogs are
    " pages, target mappings TM). The FLP runtime here is CLASSIC.
    section( '8. ROUND 3 - APP ID TO BSP / ODATA SERVICES, CATALOG TABLES' ).
    line( |Catalog folder and its app nodes in { p_brole } (parent/child):| ).
    dump_rows( iv_table = 'AGR_HIER'  iv_where = |AGR_NAME = '{ p_brole }' AND REPORT = 'SERVICE'| iv_max = p_rows ).
    dump_rows( iv_table = 'AGR_HIERT' iv_where = |AGR_NAME = '{ p_brole }' AND SPRAS = '{ sy-langu }' AND OBJECT_ID BETWEEN '00000180' AND '00000200'| iv_max = 12 ).
    line( 'SU22 data of a Fiori app id (S_SERVICE defaults name the OData services):' ).
    field_list( 'USOBHASH' ).
    field_list( 'USOBT' ).
    dump_rows( iv_table = 'USOBT' iv_where = |NAME = 'F1873' AND OBJECT = 'S_SERVICE'| iv_max = p_rows ).
    dump_rows( iv_table = 'USOBT' iv_where = |NAME = 'F0029'| iv_max = p_rows ).
    dump_rows( iv_table = 'USOBHASH' iv_where = |OBJ_NAME LIKE '%SD_F1873%' OR OBJ_NAME LIKE '%F1873%'| iv_max = p_rows ).
    dump_rows( iv_table = 'USOBHASH' iv_where = |TYPE = 'IWSG'| iv_max = 4 ).
    dump_rows( iv_table = 'USOBHASH' iv_where = |TYPE = 'IWSV'| iv_max = 4 ).
    dump_rows( iv_table = 'USOBHASH' iv_where = |TYPE = 'HT'| iv_max = 4 ).
    line( 'Classic page-builder content: catalogs (pages), tiles (CHIPs), target mappings (TM):' ).
    field_list( '/UI2/PB_C_PAGEM' ).
    field_list( '/UI2/PB_C_CHIPM' ).
    field_list( '/UI2/PB_C_TM' ).
    field_list( '/UI2/PB_C_TMM' ).
    field_list( '/UI2/PB_C_PROPM' ).
    " One count per line: ABAP source lines end at 255 characters.
    line( |  /UI2/PB_C_PAGEM rows: { count_rows( iv_table = '/UI2/PB_C_PAGEM' iv_where = '' ) }| ).
    line( |  /UI2/PB_C_CHIPM rows: { count_rows( iv_table = '/UI2/PB_C_CHIPM' iv_where = '' ) }| ).
    line( |  /UI2/PB_C_TMM rows: { count_rows( iv_table = '/UI2/PB_C_TMM' iv_where = '' ) }| ).
    line( |  /UI2/PB_C_TM rows: { count_rows( iv_table = '/UI2/PB_C_TM' iv_where = '' ) }| ).
    dump_rows( iv_table = '/UI2/PB_C_PAGEM' iv_where = |ID LIKE '%SAP_SD_BC_SO_DISPL%'| iv_max = 3 ).
    dump_rows( iv_table = '/UI2/PB_C_PAGEM' iv_where = |ID LIKE '%SAP_TC_SD%'| iv_max = 3 ).
    dump_rows( iv_table = '/UI2/PB_C_CHIPM' iv_where = |PAGE_ID LIKE '%SAP_SD_BC_SO_DISPL%'| iv_max = 3 ).
    dump_rows( iv_table = '/UI2/PB_C_TMM'   iv_where = '' iv_max = 3 ).
    dump_rows( iv_table = '/UI2/PB_C_TM'    iv_where = '' iv_max = 3 ).
    line( 'Technical catalogs (TADIR UIAC, 200 entries) and one business application (UIBA):' ).
    dump_rows( iv_table = 'TADIR' iv_where = |PGMID = 'R3TR' AND OBJECT = 'UIAC' AND OBJ_NAME LIKE 'SAP_TC_SD%'| iv_max = 4 ).
    list_tables( '/UI2/APPDESC%' ).
    list_tables( '/UI2/AD%' ).
    list_tables( '/UI2/TC%' ).
    list_tables( '/UI2/FDM%' ).
    list_tables( '/UI2/FCM%' ).
    line( 'V2 service of a known app and its activation row:' ).
    dump_rows( iv_table = '/IWFND/I_MED_SRH' iv_where = |SERVICE_NAME LIKE 'SD_F1873%' OR SERVICE_NAME LIKE '%SALESORDER%MANAGE%'| iv_max = 4 ).
    dump_rows( iv_table = '/IWFND/I_MED_SRH' iv_where = |IS_ACTIVE = 'A' AND IS_SAP_SERVICE = 'X'| iv_max = 3 ).
  ENDMETHOD.

  METHOD manual_follow_ups.
    section( '6. MANUAL FOLLOW-UPS (WRITE THE ANSWERS INTO docu/08)' ).
    line( '- From section 1: which /IAM/ column carries the Fiori ID (F1234), the' ).
    line( '  UI5 component, the BSP application and the catalog assignment.' ).
    line( '- From section 2: confirm the ICF node name equals the BSP name in lower' ).
    line( '  case under /sap/bc/ui5_ui5/sap/ and that ICF_NOACT is the active flag.' ).
    line( '- From section 3: which /IWFND/ table carries the service activation' ).
    line( '  state and how V4 services (S/4HANA 2023) are registered.' ).
    line( '- From section 4: the catalog tables that link a business catalog to' ).
    line( '  its apps (CDM3), and how spaces/pages reference catalogs.' ).
    line( '- From section 5: the AGR_HIER node type and the catalog id column.' ).
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

  METHOD list_tables.
    DATA lv_pattern TYPE dd02l-tabname.
    lv_pattern = iv_pattern.
    SELECT COUNT(*) FROM dd02l
      WHERE tabname LIKE @lv_pattern AND tabclass = 'TRANSP' AND as4local = 'A'
      INTO @DATA(lv_total).
    line( |  pattern { iv_pattern }: { lv_total } transparent tables| ).
    SELECT tabname FROM dd02l
      WHERE tabname LIKE @lv_pattern AND tabclass = 'TRANSP' AND as4local = 'A'
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
        IF iv_where IS INITIAL.
          SELECT COUNT(*) FROM (iv_table) INTO @rv_count.
        ELSE.
          SELECT COUNT(*) FROM (iv_table) WHERE (iv_where) INTO @rv_count.
        ENDIF.
      " cx_sy_dynamic_osql_semantics is a subclass of the OSQL error: one CATCH.
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
        IF iv_where IS INITIAL.
          SELECT * FROM (iv_table) INTO TABLE @<lt_rows> UP TO @iv_max ROWS.
        ELSE.
          SELECT * FROM (iv_table) WHERE (iv_where) INTO TABLE @<lt_rows> UP TO @iv_max ROWS.
        ENDIF.
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
        IF sy-subrc = 0 AND <lv_value> IS NOT INITIAL.
          lv_text = |{ lv_text } { ls_comp-name }=[{ <lv_value> }]|.
        ENDIF.
      ENDLOOP.
      line( |     { lv_text }| ).
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_probe( )->run( ).
