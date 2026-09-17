"---------------------------------------------------------------------
" Local handler for the ZADO_ACT_I_LOG managed behaviour.
"
" The static action executeStep calls the Remote-Enabled wrapper
" Z_ADO_ACT_EXEC_STEP via DESTINATION 'NONE': the step FMs' internal
" COMMIT WORK runs in that separate session, isolated from the RAP
" transaction. The wrapper returns the step-result JSON, passed back
" unchanged in ResultJson (the CAP adapter parses it). The action does
" not persist instances - the log table exists only to make the entity
" a valid RAP BO root (custom entities cannot host behaviour on 2023).
"---------------------------------------------------------------------
CLASS lhc_log DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS executestep FOR MODIFY
      IMPORTING keys FOR ACTION zado_act_i_log~executestep RESULT result.
ENDCLASS.


CLASS lhc_log IMPLEMENTATION.

  METHOD executestep.
    LOOP AT keys INTO DATA(ls_key).
      DATA lv_result_json TYPE string.
      DATA lv_sysmsg      TYPE string.
      CLEAR: lv_result_json, lv_sysmsg.

      " Read-only state probe (simulation): no LUW, so no RFC hop needed.
      IF ls_key-%param-probe = abap_true.
        DATA(ls_probe) = zcl_ado_act_probe=>probe_step(
          iv_step_type       = ls_key-%param-steptype
          iv_object_key_json = ls_key-%param-objectkeyjson ).
        lv_result_json = /ui2/cl_json=>serialize(
                           data        = ls_probe
                           pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
        APPEND VALUE #( %cid              = ls_key-%cid
                        %param-resultjson = lv_result_json ) TO result.
        CONTINUE.
      ENDIF.

      CALL FUNCTION 'Z_ADO_ACT_EXEC_STEP' DESTINATION 'NONE'
        EXPORTING
          iv_step_type          = ls_key-%param-steptype
          iv_object_key_json    = ls_key-%param-objectkeyjson
        IMPORTING
          ev_result_json        = lv_result_json
        EXCEPTIONS
          system_failure        = 1 MESSAGE lv_sysmsg
          communication_failure = 2 MESSAGE lv_sysmsg
          OTHERS                = 3.
      IF sy-subrc <> 0.
        lv_result_json =
          |\{"status":"FAILED","existsAlready":false,"messages":| &&
          |[\{"type":"E","message":"RFC Z_ADO_ACT_EXEC_STEP failed | &&
          |(subrc { sy-subrc }) { lv_sysmsg }"\}]\}|.
      ENDIF.

      APPEND VALUE #( %cid              = ls_key-%cid
                      %param-resultjson = lv_result_json ) TO result.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
