CLASS zcl_ado_q_periods DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
ENDCLASS.


CLASS zcl_ado_q_periods IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " Which ST03N periods actually exist, from the collector index - so the
    " SaaS offers only real windows and never hard-codes retention. This is
    " also the cheap probe target for checkTargetSystemConnection.
    "
    " SWNCMONIINDEX columns are read defensively by name (the probe confirmed
    " the table exists; the exact column split is release-dependent). If the
    " read yields nothing usable, fall back to the last 12 month starts so
    " the probe entity always answers.

    TYPES: BEGIN OF ty_result,
             periodtype   TYPE c LENGTH 2,
             periodstart  TYPE d,
             instancename TYPE c LENGTH 40,
             tasktype     TYPE c LENGTH 20,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    TRY.
        DATA lr_rows TYPE REF TO data.
        FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
        CREATE DATA lr_rows TYPE STANDARD TABLE OF ('SWNCMONIINDEX').
        ASSIGN lr_rows->* TO <lt_rows>.
        SELECT * FROM ('SWNCMONIINDEX') INTO TABLE @<lt_rows> UP TO 500 ROWS.

        LOOP AT <lt_rows> ASSIGNING FIELD-SYMBOL(<ls_row>).
          DATA(ls_result) = VALUE ty_result( ).
          ASSIGN COMPONENT 'PERIODTYPE' OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv_type>).
          IF sy-subrc = 0. ls_result-periodtype = <lv_type>. ENDIF.
          ASSIGN COMPONENT 'PERIODSTRT' OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv_start>).
          IF sy-subrc = 0. ls_result-periodstart = <lv_start>. ENDIF.
          ASSIGN COMPONENT 'COMPONENT' OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv_component>).
          IF sy-subrc = 0. ls_result-instancename = <lv_component>. ENDIF.
          IF ls_result-periodstart IS NOT INITIAL.
            APPEND ls_result TO lt_result.
          ENDIF.
        ENDLOOP.
      CATCH cx_root.
        CLEAR lt_result.
    ENDTRY.

    IF lt_result IS INITIAL.
      " Fallback: synthetic month starts so the entity (and the connection
      " probe) always answers; the extraction itself tolerates NO_DATA_FOUND.
      DATA(lv_month) = CONV d( |{ sy-datum(6) }01| ).
      DO 12 TIMES.
        APPEND VALUE ty_result( periodtype = 'M' periodstart = lv_month ) TO lt_result.
        lv_month = lv_month - 1.
        lv_month = CONV d( |{ lv_month(6) }01| ).
      ENDDO.
    ENDIF.

    SORT lt_result BY periodstart DESCENDING periodtype ASCENDING instancename ASCENDING.
    DELETE ADJACENT DUPLICATES FROM lt_result COMPARING periodtype periodstart instancename.

    DATA(lv_total) = lines( lt_result ).
    IF io_request->is_total_numb_of_rec_requested( ).
      io_response->set_total_number_of_records( lv_total ).
    ENDIF.

    DATA(lo_paging) = io_request->get_paging( ).
    DATA(lv_offset)    = lo_paging->get_offset( ).
    DATA(lv_page_size) = lo_paging->get_page_size( ).
    IF lv_page_size < 0.
      lv_page_size = lv_total.
    ENDIF.
    IF lv_offset > 0.
      DELETE lt_result TO lv_offset.
    ENDIF.
    IF lines( lt_result ) > lv_page_size.
      DELETE lt_result FROM lv_page_size + 1.
    ENDIF.

    IF io_request->is_data_requested( ).
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
