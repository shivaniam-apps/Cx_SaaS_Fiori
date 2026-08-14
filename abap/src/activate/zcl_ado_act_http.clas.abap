CLASS zcl_ado_act_http DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " HTTP front door of the activation write unit (DEV ONLY).
    "
    " Deliberately a plain ICF handler, NOT a RAP service: RAP forbids
    " COMMIT WORK inside behavior handlers, and the dispatcher's
    " contract is exactly one LUW per step (see ZCL_ADO_ACTIVATE).
    "
    " Contract with the AdoptOps SaaS (s4-activate-adapter.js):
    "   GET  <node>  -> 200 info/ping JSON (existence + identity probe)
    "   POST <node>  -> body { "stepType": "...",
    "                          "objectKeyJson": "<json string>" }
    "                -> 200 with the ZIF_ADO_ACT_STEP result serialized
    "                   camelCase: { status, existsAlready, trkorr,
    "                   messages: [ { type, message, ... } ] }
    "   errors       -> 400 bad payload | 405 wrong method | 500 with
    "                   { "error": "..." } (LUW rolled back)
    "
    " PUBLICATION IS THE SAFETY GATE and stays manual: create the SICF
    " node in DEV only (SICF -> default_host/sap/bc -> New Sub-Element
    " 'zado_act', handler ZCL_ADO_ACT_HTTP, standard logon). The node
    " is never transported; without it this class is unreachable, which
    " is the required state in QA/PROD.
    "---------------------------------------------------------------
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_request,
             step_type       TYPE string,
             object_key_json TYPE string,
           END OF ty_request.

    METHODS send_json
      IMPORTING io_response TYPE REF TO if_http_response
                iv_status   TYPE i
                iv_reason   TYPE string
                iv_json     TYPE string.

    METHODS json_escape
      IMPORTING iv_value       TYPE string
      RETURNING VALUE(rv_text) TYPE string.

ENDCLASS.


CLASS zcl_ado_act_http IMPLEMENTATION.

  METHOD if_http_extension~handle_request.
    DATA(lv_method) = server->request->get_header_field( '~request_method' ).

    IF lv_method = 'GET'.
      " Existence/identity probe for connection checks - no writes.
      send_json(
        io_response = server->response
        iv_status   = 200
        iv_reason   = 'OK'
        iv_json     = |\{ "service": "adoptops-activate", "version": 1, | &&
                      |"system": "{ sy-sysid }", "client": "{ sy-mandt }" \}| ).
      RETURN.
    ENDIF.

    IF lv_method <> 'POST'.
      send_json(
        io_response = server->response
        iv_status   = 405
        iv_reason   = 'Method Not Allowed'
        iv_json     = |\{ "error": "Use GET (probe) or POST (execute step)." \}| ).
      RETURN.
    ENDIF.

    DATA ls_request TYPE ty_request.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json        = server->request->get_cdata( )
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data        = ls_request ).
      CATCH cx_root.
        CLEAR ls_request.
    ENDTRY.

    IF ls_request-step_type IS INITIAL.
      send_json(
        io_response = server->response
        iv_status   = 400
        iv_reason   = 'Bad Request'
        iv_json     = |\{ "error": "Body must provide stepType and objectKeyJson." \}| ).
      RETURN.
    ENDIF.

    TRY.
        DATA(ls_result) = zcl_ado_activate=>execute_step(
          iv_step_type       = ls_request-step_type
          iv_object_key_json = ls_request-object_key_json ).
        send_json(
          io_response = server->response
          iv_status   = 200
          iv_reason   = 'OK'
          iv_json     = /ui2/cl_json=>serialize(
                          data        = ls_result
                          pretty_name = /ui2/cl_json=>pretty_mode-camel_case ) ).
      CATCH cx_root INTO DATA(lx_error).
        " The dispatcher commits or rolls back per step; an escaped
        " exception means the step LUW must not survive either.
        ROLLBACK WORK.
        send_json(
          io_response = server->response
          iv_status   = 500
          iv_reason   = 'Internal Server Error'
          iv_json     = |\{ "error": "{ json_escape( lx_error->get_text( ) ) }" \}| ).
    ENDTRY.
  ENDMETHOD.

  METHOD send_json.
    io_response->set_status( code = iv_status reason = iv_reason ).
    io_response->set_content_type( 'application/json' ).
    io_response->set_cdata( iv_json ).
  ENDMETHOD.

  METHOD json_escape.
    rv_text = iv_value.
    REPLACE ALL OCCURRENCES OF '\' IN rv_text WITH '\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv_text WITH '\"'.
    REPLACE ALL OCCURRENCES OF REGEX '[[:cntrl:]]' IN rv_text WITH ''.
  ENDMETHOD.

ENDCLASS.
