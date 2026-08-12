@EndUserText.label: 'AdoptOps User x Transaction Usage (ST03N, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_USER_TX'
define custom entity ZADO_C_USER_TX_USAGE
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
