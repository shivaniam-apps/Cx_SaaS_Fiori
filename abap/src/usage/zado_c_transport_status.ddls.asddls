@EndUserText.label: 'AdoptOps Transport Status (E070, live)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_ADO_Q_TRANSPORT'
// One row per transport request known to THIS system (E070). On the
// source system that is the request's own status (D/L modifiable, O
// release started, R released). On a follow-on system (QA, PROD) the
// request exists in E070 only once tp imported it - the object list
// travels with the import - so its presence there is the import evidence
// AdoptOps verifies through the read unit (S10). Filterable by Trkorr
// (required: without a range the provider answers nothing); paged.
define custom entity ZADO_C_TRANSPORT_STATUS
{
      @EndUserText.label: 'Request'
  key Trkorr        : abap.char(20);

      @EndUserText.label: 'Request Type'
      RequestType   : abap.char(1);

      @EndUserText.label: 'Request Status'
      RequestStatus : abap.char(1);

      @EndUserText.label: 'Owner'
      Owner         : abap.char(12);

      @EndUserText.label: 'Transport Target'
      TargetSystem  : abap.char(10);

      @EndUserText.label: 'Parent Request'
      ParentRequest : abap.char(20);

      @EndUserText.label: 'Changed On'
      ChangedOn     : abap.dats;

      @EndUserText.label: 'Changed At'
      ChangedAt     : abap.tims;

      @EndUserText.label: 'Description'
      Description   : abap.char(60);

      @EndUserText.label: 'Objects'
      ObjectCount   : abap.int4;

      @EndUserText.label: 'Answering System'
      SystemId      : abap.char(8);

      @EndUserText.label: 'Answering Client'
      Client        : abap.char(3);
}
