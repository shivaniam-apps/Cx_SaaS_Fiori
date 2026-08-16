@EndUserText.label: 'AdoptOps System Info'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_SYSTEM_INFO'
define custom entity ZADO_C_SYSTEM_INFO
{
      @EndUserText.label: 'System ID'
  key SystemId         : abap.char(8);

      @EndUserText.label: 'Client'
      Client           : abap.char(3);

      @EndUserText.label: 'S/4 Release'
      S4Release        : abap.char(10);

      @EndUserText.label: 'SAP_UI Release'
      SapUi5Version    : abap.char(10);

      @EndUserText.label: 'Workload Collector Running'
      CollectorRunning : abap.char(1);

      @EndUserText.label: 'Add-On Version'
      AddOnVersion     : abap.char(20);
}
