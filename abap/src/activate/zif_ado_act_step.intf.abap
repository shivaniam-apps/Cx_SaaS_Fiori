INTERFACE zif_ado_act_step
  PUBLIC.

  "-------------------------------------------------------------------
  " Shared contract of every activation step executor.
  "
  " Semantics (CAP ActivationSteps mirror):
  " - SKIPPED + exists_already: verify-first found the object in the
  "   target state; nothing was executed. Resume-safe by construction.
  " - SUCCESS: executed and verified-after.
  " - WARNING: executed; verification passed with caveats (recorded in
  "   messages, e.g. irreversibility).
  " - FAILED: not executed or verification failed; the dispatcher rolls
  "   back the step LUW.
  "-------------------------------------------------------------------

  CONSTANTS:
    BEGIN OF c_status,
      success TYPE string VALUE 'SUCCESS',
      warning TYPE string VALUE 'WARNING',
      failed  TYPE string VALUE 'FAILED',
      skipped TYPE string VALUE 'SKIPPED',
    END OF c_status.

  TYPES ty_messages TYPE STANDARD TABLE OF bapiret2 WITH EMPTY KEY.

  TYPES: BEGIN OF ty_result,
           status         TYPE string,
           exists_already TYPE abap_bool,
           trkorr         TYPE trkorr,
           messages       TYPE ty_messages,
         END OF ty_result.

  " Read-side state probe (simulation, ZCL_ADO_ACT_PROBE): the verdicts
  " are the CAP simulation statuses of ActivationSteps. exists_already
  " means the executor will SKIP the step; BLOCKED means it cannot run.
  CONSTANTS:
    BEGIN OF c_verdict,
      ok      TYPE string VALUE 'SIMULATED_OK',
      warning TYPE string VALUE 'SIMULATED_WARN',
      blocked TYPE string VALUE 'SIMULATED_BLOCKED',
    END OF c_verdict.

  TYPES: BEGIN OF ty_probe,
           verdict        TYPE string,
           exists_already TYPE abap_bool,
           message        TYPE string,
         END OF ty_probe.

ENDINTERFACE.
