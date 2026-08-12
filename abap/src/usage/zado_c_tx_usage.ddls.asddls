@EndUserText.label: 'AdoptOps Transaction Usage (ST03N, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_TX_USAGE'
define custom entity ZADO_C_TX_USAGE
{
      @EndUserText.label: 'Transaction Code'
  key TransactionCode      : abap.char(20);

      @EndUserText.label: 'Description'
      TransactionText      : abap.char(120);

      @EndUserText.label: 'Program'
      ProgramName          : abap.char(40);

      @EndUserText.label: 'Application Component'
      ApplicationComponent : abap.char(40);

      @EndUserText.label: 'Period From'
      PeriodFrom           : abap.dats;

      @EndUserText.label: 'Period To'
      PeriodTo             : abap.dats;

      @EndUserText.label: 'Executions'
      ExecutionCount       : abap.int8;

      @EndUserText.label: 'Dialog Steps'
      DialogStepCount      : abap.int8;

      @EndUserText.label: 'Distinct Users'
      DistinctUserCount    : abap.int4;

      @EndUserText.label: 'Total Response Time (ms)'
      TotalResponseTimeMs  : abap.dec(16,2);

      @EndUserText.label: 'Avg Response Time (ms)'
      AvgResponseTimeMs    : abap.dec(16,2);

      @EndUserText.label: 'Total CPU Time (ms)'
      TotalCpuTimeMs       : abap.dec(16,2);

      @EndUserText.label: 'Total DB Time (ms)'
      TotalDbTimeMs        : abap.dec(16,2);

      @EndUserText.label: 'Last Used On'
      LastUsedOn           : abap.dats;
}
