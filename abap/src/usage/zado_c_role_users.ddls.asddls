@EndUserText.label: 'AdoptOps Role Assignments (AGR_USERS, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_ROLE_USERS'
// One row per role x user assignment, user pseudonymised with the same
// hash as the usage and inventory readers. Paged at the database,
// filterable by RoleName.
define custom entity ZADO_C_ROLE_USERS
{
      @EndUserText.label: 'Role'
  key RoleName  : abap.char(30);

      @EndUserText.label: 'User (pseudonymised)'
  key UserKey   : abap.char(64);

      @EndUserText.label: 'Valid From'
      ValidFrom : abap.dats;

      @EndUserText.label: 'Valid To'
      ValidTo   : abap.dats;
}
