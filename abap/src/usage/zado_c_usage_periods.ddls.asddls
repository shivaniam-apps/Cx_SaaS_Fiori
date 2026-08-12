@EndUserText.label: 'AdoptOps Available ST03N Periods'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_PERIODS'
define custom entity ZADO_C_USAGE_PERIODS
{
      @EndUserText.label: 'Period Type'
  key PeriodType   : abap.char(2);

      @EndUserText.label: 'Period Start'
  key PeriodStart  : abap.dats;

      @EndUserText.label: 'Instance'
      InstanceName : abap.char(40);

      @EndUserText.label: 'Task Type'
      TaskType     : abap.char(20);
}
