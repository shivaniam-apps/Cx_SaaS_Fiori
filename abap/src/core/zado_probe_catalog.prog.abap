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
    dump_rows( iv_table = '/UI2/STHEADT' iv_where = |LANGUAGE = '{ sy-langu }'| iv_max = p_rows ).
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
