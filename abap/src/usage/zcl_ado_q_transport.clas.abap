CLASS zcl_ado_q_transport DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.

  PRIVATE SECTION.
    TYPES ty_r_trkorr TYPE RANGE OF e070-trkorr.
ENDCLASS.


CLASS zcl_ado_q_transport IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " E070 rows for the requested TRKORR range, paged at the database
    " (S10). On a follow-on system a request appears in E070 only after
    " tp imported it, so the row itself is the import evidence; the tp
    " return code of that import lives in the TMS logs and is NOT read
    " here (docu/09-activation-and-transport/transport-verification.md).

    TYPES: BEGIN OF ty_result,
             trkorr        TYPE c LENGTH 20,
             requesttype   TYPE c LENGTH 1,
             requeststatus TYPE c LENGTH 1,
             owner         TYPE c LENGTH 12,
             targetsystem  TYPE c LENGTH 10,
             parentrequest TYPE c LENGTH 20,
             changedon     TYPE d,
             changedat     TYPE t,
             description   TYPE c LENGTH 60,
             objectcount   TYPE i,
             systemid      TYPE c LENGTH 8,
             client        TYPE c LENGTH 3,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    DATA lt_r_trkorr TYPE ty_r_trkorr.
    LOOP AT zcl_ado_q_util=>ranges_of( io_request = io_request iv_name = 'TRKORR' ) INTO DATA(ls_range).
      APPEND VALUE #( sign = ls_range-sign option = ls_range-option low = ls_range-low high = ls_range-high ) TO lt_r_trkorr.
    ENDLOOP.

    " An unbounded read of E070 is never what the SaaS side wants: a
    " request without a TRKORR filter answers nothing instead of paging
    " the whole transport history of the system.
    IF lt_r_trkorr IS INITIAL.
      IF io_request->is_total_numb_of_rec_requested( ).
        io_response->set_total_number_of_records( 0 ).
      ENDIF.
      IF io_request->is_data_requested( ).
        io_response->set_data( lt_result ).
      ENDIF.
      RETURN.
    ENDIF.

    zcl_ado_q_util=>paging(
      EXPORTING io_request   = io_request
      IMPORTING ev_offset    = DATA(lv_offset)
                ev_page_size = DATA(lv_size) ).

    IF io_request->is_total_numb_of_rec_requested( ).
      SELECT COUNT(*) FROM e070
        WHERE trkorr IN @lt_r_trkorr
        INTO @DATA(lv_total).
      io_response->set_total_number_of_records( lv_total ).
    ENDIF.

    IF io_request->is_data_requested( ).
      SELECT trkorr, trfunction, trstatus, as4user, tarsystem, strkorr, as4date, as4time
        FROM e070
        WHERE trkorr IN @lt_r_trkorr
        ORDER BY trkorr
        INTO TABLE @DATA(lt_e070)
        UP TO @lv_size ROWS OFFSET @lv_offset.

      " A page is one request in practice (the filter is an EQ on the
      " TRKORR), so the text and object count are read per row.
      LOOP AT lt_e070 INTO DATA(ls_e070).
        DATA(ls_row) = VALUE ty_result(
          trkorr        = ls_e070-trkorr
          requesttype   = ls_e070-trfunction
          requeststatus = ls_e070-trstatus
          owner         = ls_e070-as4user
          targetsystem  = ls_e070-tarsystem
          parentrequest = ls_e070-strkorr
          changedon     = ls_e070-as4date
          changedat     = ls_e070-as4time
          systemid      = sy-sysid
          client        = sy-mandt ).

        SELECT SINGLE as4text FROM e07t
          WHERE trkorr = @ls_e070-trkorr AND langu = @sy-langu
          INTO @ls_row-description.
        IF sy-subrc <> 0.
          SELECT SINGLE as4text FROM e07t
            WHERE trkorr = @ls_e070-trkorr
            INTO @ls_row-description.
        ENDIF.

        SELECT COUNT(*) FROM e071
          WHERE trkorr = @ls_e070-trkorr
          INTO @ls_row-objectcount.

        APPEND ls_row TO lt_result.
      ENDLOOP.

      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
