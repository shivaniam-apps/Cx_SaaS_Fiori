@EndUserText.label: 'AdoptOps Role Transactions (AGR_TCODES / AGR_1251, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_ROLE_TCODES'
// Which transactions a role grants: Source MENU = AGR_TCODES (menu
// entries of type TR), Source AUTH = AGR_1251 S_TCODE/TCD values (the
// only place SAP_BR_* business roles carry tcodes). The SaaS reads each
// source with $filter=Source eq '...'; paged at the database.
define custom entity ZADO_C_ROLE_TCODES
{
      @EndUserText.label: 'Role'
  key RoleName        : abap.char(30);

      @EndUserText.label: 'Transaction Code'
  key TransactionCode : abap.char(20);

      @EndUserText.label: 'Source (MENU | AUTH)'
  key Source          : abap.char(10);
}
