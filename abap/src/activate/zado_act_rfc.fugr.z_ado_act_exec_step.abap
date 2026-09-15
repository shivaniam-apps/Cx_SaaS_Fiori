FUNCTION z_ado_act_exec_step.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     VALUE(IV_STEP_TYPE) TYPE  STRING
*"     VALUE(IV_OBJECT_KEY_JSON) TYPE  STRING
*"  EXPORTING
*"     VALUE(EV_RESULT_JSON) TYPE  STRING
*"----------------------------------------------------------------------

  DATA(ls_result) = zcl_ado_activate=>execute_step(
    iv_step_type       = iv_step_type
    iv_object_key_json = iv_object_key_json ).
  ev_result_json = /ui2/cl_json=>serialize(
                     data        = ls_result
                     pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).


ENDFUNCTION.
