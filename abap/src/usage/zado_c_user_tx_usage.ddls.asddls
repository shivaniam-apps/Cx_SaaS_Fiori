@EndUserText.label: 'AdoptOps User x Tx Usage (ST03N, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_USER_TX'
// Extraction parameters are bound at the SOURCE (ZCL_ADO_ST03_READER):
// only the top-N users per transaction above the execution threshold leave
// the system. The SaaS reads UserTransactionUsage(P_TopUsers=..,
// P_MinExecutions=..,P_TenantId='..')/Set; without parameters the reader
// defaults apply (20 users, 1 execution, no tenant scope).
// P_TenantId (A9) is mixed into the pseudonym salt: the same SAP user read
// by two AdoptOps tenants yields two different pseudonyms.
define custom entity ZADO_C_USER_TX_USAGE
  with parameters
    @EndUserText.label: 'Top users per transaction (0 = all)'
    P_TopUsers      : abap.int4,
    @EndUserText.label: 'Minimum executions per user row'
    P_MinExecutions : abap.int4,
    @EndUserText.label: 'AdoptOps tenant (pseudonym salt scope)'
    P_TenantId      : abap.char(60)
{
      @EndUserText.label: 'User (pseudonymised)'
  key UserKey           : abap.char(64);

      @EndUserText.label: 'Transaction Code'
  key TransactionCode   : abap.char(20);

      @EndUserText.label: 'Period From'
      PeriodFrom        : abap.dats;

      @EndUserText.label: 'Period To'
      PeriodTo          : abap.dats;

      @EndUserText.label: 'Executions'
      ExecutionCount    : abap.int8;

      @EndUserText.label: 'Dialog Steps'
      DialogStepCount   : abap.int8;

      @EndUserText.label: 'Last Used On'
      LastUsedOn        : abap.dats;
}
