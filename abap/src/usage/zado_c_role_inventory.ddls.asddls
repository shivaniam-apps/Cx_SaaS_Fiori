@EndUserText.label: 'AdoptOps Role Inventory (AGR_DEFINE, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_ROLE_INV'
// One row per PFCG role with the counts the landscape needs, computed
// per page window at the database (menu tcodes from AGR_TCODES, S_TCODE
// values from AGR_1251, assignments from AGR_USERS). Paged and
// filterable by RoleName.
define custom entity ZADO_C_ROLE_INVENTORY
{
      @EndUserText.label: 'Role'
  key RoleName       : abap.char(30);

      @EndUserText.label: 'Description'
      RoleText       : abap.char(80);

      @EndUserText.label: 'Role Type'
      RoleType       : abap.char(10);

      @EndUserText.label: 'Parent Role'
      ParentRole     : abap.char(30);

      @EndUserText.label: 'SAP Delivered'
      IsSapDelivered : abap_boolean;

      @EndUserText.label: 'Menu Transactions'
      MenuTcodeCount : abap.int4;

      @EndUserText.label: 'S_TCODE Values'
      AuthTcodeCount : abap.int4;

      @EndUserText.label: 'Assigned Users'
      UserCount      : abap.int4;

      @EndUserText.label: 'Changed On'
      ChangedOn      : abap.dats;
}
