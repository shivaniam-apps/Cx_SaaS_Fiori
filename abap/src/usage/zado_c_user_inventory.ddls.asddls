@EndUserText.label: 'AdoptOps User Inventory (USR02, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_USER_INV'
// One row per user master record. UserKey is the same pseudonym the
// ST03N reader emits, so the SaaS correlates roles, users and usage
// without ever holding the identity. Paged at the database
// ($top/$skip/$count), filterable by UserType.
define custom entity ZADO_C_USER_INVENTORY
{
      @EndUserText.label: 'User (pseudonymised)'
  key UserKey     : abap.char(64);

      @EndUserText.label: 'User Type'
      UserType    : abap.char(1);

      @EndUserText.label: 'User Group'
      UserGroup   : abap.char(12);

      @EndUserText.label: 'Valid From'
      ValidFrom   : abap.dats;

      @EndUserText.label: 'Valid To'
      ValidTo     : abap.dats;

      @EndUserText.label: 'Lock Flag (USR02-UFLAG)'
      LockFlag    : abap.int4;

      @EndUserText.label: 'Last Logon'
      LastLogonOn : abap.dats;

      @EndUserText.label: 'Assigned Roles'
      RoleCount   : abap.int4;
}
