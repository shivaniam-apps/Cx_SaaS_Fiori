@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'AdoptOps activation endpoint'
define root view entity ZADO_ACT_I_LOG
  as select from zado_act_log
{
  key log_uuid   as LogUuid,
      step_type  as StepType,
      status     as Status,
      created_at as CreatedAt
}
