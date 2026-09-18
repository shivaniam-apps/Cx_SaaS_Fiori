CLASS zcl_ado_q_system_info DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.

    CONSTANTS gc_addon_version TYPE string VALUE '0.1.0'.
ENDCLASS.


CLASS zcl_ado_q_system_info IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " Single-row identity + capability card for the SaaS Target Systems page.

    TYPES: BEGIN OF ty_result,
             systemid         TYPE c LENGTH 8,
             client           TYPE c LENGTH 3,
             s4release        TYPE c LENGTH 10,
             sapui5version    TYPE c LENGTH 10,
             collectorrunning TYPE c LENGTH 1,
             addonversion     TYPE c LENGTH 20,
             snapshotfrom     TYPE d,
             snapshotto       TYPE d,
             snapshotmonths   TYPE i,
             snapshotcollectedon TYPE d,
             snapshotcollectedat TYPE t,
             collectorjobscheduled TYPE c LENGTH 1,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    DATA(ls_row) = VALUE ty_result(
      systemid     = sy-sysid
      client       = sy-mandt
      addonversion = gc_addon_version ).

    SELECT SINGLE release FROM cvers WHERE component = 'S4CORE'
      INTO @DATA(lv_s4core).
    IF sy-subrc = 0.
      ls_row-s4release = lv_s4core.
    ENDIF.
    SELECT SINGLE release FROM cvers WHERE component = 'SAP_UI'
      INTO @DATA(lv_sapui).
    IF sy-subrc = 0.
      ls_row-sapui5version = lv_sapui.
    ENDIF.

    " Without SAP_COLLECTOR_FOR_PERFMONITOR there is no ST03N history.
    SELECT COUNT(*) FROM tbtco
      WHERE jobname = 'SAP_COLLECTOR_FOR_PERFMONITOR'
        AND status IN ( 'S', 'R', 'F' )
      INTO @DATA(lv_jobs).
    ls_row-collectorrunning = COND #( WHEN lv_jobs > 0 THEN 'X' ELSE '' ).

    " S7: snapshot coverage and whether ZADO_COLLECT_USAGE is scheduled
    " (a released or scheduled job step running that report).
    DATA(ls_coverage) = zcl_ado_snap_reader=>coverage( ).
    ls_row-snapshotfrom   = ls_coverage-period_from.
    ls_row-snapshotto     = ls_coverage-period_to.
    ls_row-snapshotmonths = ls_coverage-months.
    IF ls_coverage-collected_at IS NOT INITIAL.
      CONVERT TIME STAMP ls_coverage-collected_at TIME ZONE 'UTC'
        INTO DATE ls_row-snapshotcollectedon TIME ls_row-snapshotcollectedat.
    ENDIF.
    SELECT COUNT(*) FROM tbtcp AS p
      INNER JOIN tbtco AS o ON o~jobname = p~jobname AND o~jobcount = p~jobcount
      WHERE p~progname = 'ZADO_COLLECT_USAGE'
        AND o~status IN ( 'S', 'P', 'R', 'Y' )
      INTO @DATA(lv_collect_jobs).
    ls_row-collectorjobscheduled = COND #( WHEN lv_collect_jobs > 0 THEN 'X' ELSE '' ).

    APPEND ls_row TO lt_result.

    IF io_request->is_total_numb_of_rec_requested( ).
      io_response->set_total_number_of_records( 1 ).
    ENDIF.
    IF io_request->is_data_requested( ).
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
