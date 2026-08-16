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

    APPEND ls_row TO lt_result.

    IF io_request->is_total_numb_of_rec_requested( ).
      io_response->set_total_number_of_records( 1 ).
    ENDIF.
    IF io_request->is_data_requested( ).
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
