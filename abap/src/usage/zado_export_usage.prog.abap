REPORT zado_export_usage.

"---------------------------------------------------------------------
" AdoptOps offline usage export (read-only).
"
" For landscapes where the Cloud Connector path to the SaaS is not (yet)
" open: runs ZCL_ADO_ST03_READER over the selected window and downloads
" the result as a JSON file via SAP GUI. The file is imported in the
" AdoptOps UI (Extractions -> Import Extract) and becomes a normal
" extraction run - same screens, same proposal engine, real data.
"
" User ids are pseudonymised by ZCL_ADO_PSEUDONYM unless P_IDENT is
" checked (identified export requires an explicit tick, mirroring the
" audited opt-in the connected mode enforces).
"---------------------------------------------------------------------

" Selection screen with labels maintained IN THE PROGRAM: each parameter
" sits in a line with a named COMMENT element whose text is assigned at
" INITIALIZATION - no Text Elements maintenance needed.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_from FOR FIELD p_from.
PARAMETERS p_from TYPE d OBLIGATORY DEFAULT '20260201'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_to FOR FIELD p_to.
PARAMETERS p_to TYPE d OBLIGATORY DEFAULT '20260731'.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_top FOR FIELD p_top.
PARAMETERS p_top TYPE i DEFAULT 20.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_ident FOR FIELD p_ident.
PARAMETERS p_ident AS CHECKBOX DEFAULT ''.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_from  = 'Period from'.
  c_to    = 'Period to'.
  c_top   = 'Top users per transaction'.
  c_ident = 'Identified export (opt-in)'.

CLASS lcl_export DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.
  PRIVATE SECTION.
    METHODS iso IMPORTING iv_date TYPE d RETURNING VALUE(rv_iso) TYPE string.
    METHODS jesc IMPORTING iv_value TYPE string RETURNING VALUE(rv_out) TYPE string.
ENDCLASS.

CLASS lcl_export IMPLEMENTATION.

  METHOD iso.
    rv_iso = |{ iv_date(4) }-{ iv_date+4(2) }-{ iv_date+6(2) }|.
  ENDMETHOD.

  METHOD jesc.
    rv_out = iv_value.
    REPLACE ALL OCCURRENCES OF '\' IN rv_out WITH '\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv_out WITH '\"'.
  ENDMETHOD.

  METHOD run.
    zcl_ado_st03_reader=>get_window(
      EXPORTING iv_from         = p_from
                iv_to           = p_to
                iv_pseudonymise = xsdbool( p_ident IS INITIAL )
                iv_top_users    = p_top
      IMPORTING et_tx_usage     = DATA(lt_tx)
                et_user_tx      = DATA(lt_user) ).

    IF lt_tx IS INITIAL.
      WRITE: / 'No ST03N data in the selected window - nothing exported.'.
      RETURN.
    ENDIF.

    DATA lt_lines TYPE STANDARD TABLE OF string WITH EMPTY KEY.
    APPEND `{` TO lt_lines.
    APPEND |  "format": "adops-usage-extract",| TO lt_lines.
    APPEND |  "formatVersion": 1,| TO lt_lines.
    APPEND |  "system": "{ sy-sysid }",| TO lt_lines.
    APPEND |  "client": "{ sy-mandt }",| TO lt_lines.
    APPEND |  "exportedAt": "{ iso( sy-datum ) }",| TO lt_lines.
    APPEND |  "pseudonymised": { COND string( WHEN p_ident IS INITIAL THEN `true` ELSE `false` ) },| TO lt_lines.
    APPEND |  "periodFrom": "{ iso( p_from ) }",| TO lt_lines.
    APPEND |  "periodTo": "{ iso( p_to ) }",| TO lt_lines.

    APPEND `  "transactions": [` TO lt_lines.
    DATA(lv_tx_total) = lines( lt_tx ).
    LOOP AT lt_tx ASSIGNING FIELD-SYMBOL(<ls_tx>).
      DATA(lv_sep) = COND string( WHEN sy-tabix < lv_tx_total THEN `,` ELSE `` ).
      APPEND |    \{"tcode":"{ jesc( CONV #( <ls_tx>-transaction_code ) ) }",| &&
             |"executions":{ <ls_tx>-execution_count },| &&
             |"dialogSteps":{ <ls_tx>-dialog_step_count },| &&
             |"users":{ <ls_tx>-distinct_user_cnt },| &&
             |"respMs":{ <ls_tx>-total_resp_ms },| &&
             |"cpuMs":{ <ls_tx>-total_cpu_ms },| &&
             |"dbMs":{ <ls_tx>-total_db_ms }\}{ lv_sep }| TO lt_lines.
    ENDLOOP.
    APPEND `  ],` TO lt_lines.

    APPEND `  "userTcodes": [` TO lt_lines.
    DATA(lv_user_total) = lines( lt_user ).
    LOOP AT lt_user ASSIGNING FIELD-SYMBOL(<ls_user>).
      DATA(lv_usep) = COND string( WHEN sy-tabix < lv_user_total THEN `,` ELSE `` ).
      APPEND |    \{"user":"{ jesc( CONV #( <ls_user>-user_key ) ) }",| &&
             |"tcode":"{ jesc( CONV #( <ls_user>-transaction_code ) ) }",| &&
             |"executions":{ <ls_user>-execution_count }\}{ lv_usep }| TO lt_lines.
    ENDLOOP.
    APPEND `  ]` TO lt_lines.
    APPEND `}` TO lt_lines.

    DATA(lv_filename) = |adops_usage_{ sy-sysid }_{ p_from }_{ p_to }.json|.
    DATA lv_fullpath TYPE string.
    DATA lv_path     TYPE string.
    DATA lv_user_action TYPE i.
    cl_gui_frontend_services=>file_save_dialog(
      EXPORTING default_file_name = lv_filename
                default_extension = 'json'
      CHANGING  filename    = lv_filename
                path        = lv_path
                fullpath    = lv_fullpath
                user_action = lv_user_action
      EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0 OR lv_user_action <> cl_gui_frontend_services=>action_ok.
      WRITE: / 'Export cancelled.'.
      RETURN.
    ENDIF.

    cl_gui_frontend_services=>gui_download(
      EXPORTING filename = lv_fullpath
                filetype = 'ASC'
                codepage = '4110'   "UTF-8
      CHANGING  data_tab = lt_lines
      EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0.
      WRITE: / 'Download failed.'.
      RETURN.
    ENDIF.

    WRITE: / |Exported { lv_tx_total } transactions and { lv_user_total } user rows to { lv_fullpath }|.
    WRITE: / 'Import in AdoptOps: Extractions -> Import Extract.'.
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  NEW lcl_export( )->run( ).
