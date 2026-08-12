CLASS zcl_ado_q_user_tx DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
ENDCLASS.


CLASS zcl_ado_q_user_tx IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " Live ST03N user x transaction rows, pseudonymised, top-N per tcode
    " bounded at the source. Only the requested page window materialises.

    TYPES: BEGIN OF ty_result,
             userkey         TYPE c LENGTH 64,
             transactioncode TYPE c LENGTH 20,
             periodfrom      TYPE d,
             periodto        TYPE d,
             executioncount  TYPE int8,
             dialogstepcount TYPE int8,
             lastusedon      TYPE d,
           END OF ty_result.
    DATA lt_paged TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    DATA(lv_from) = CONV d( sy-datum - 180 ).
    DATA(lv_to)   = sy-datum.
    DATA lv_tcode TYPE c LENGTH 20.
    TRY.
        DATA(lt_ranges) = io_request->get_filter( )->get_as_ranges( ).
        READ TABLE lt_ranges WITH KEY name = 'PERIODFROM' INTO DATA(ls_from).
        IF sy-subrc = 0 AND ls_from-range IS NOT INITIAL.
          lv_from = CONV d( ls_from-range[ 1 ]-low ).
        ENDIF.
        READ TABLE lt_ranges WITH KEY name = 'PERIODTO' INTO DATA(ls_to).
        IF sy-subrc = 0 AND ls_to-range IS NOT INITIAL.
          lv_to = CONV d( ls_to-range[ 1 ]-low ).
        ENDIF.
        READ TABLE lt_ranges WITH KEY name = 'TRANSACTIONCODE' INTO DATA(ls_tcode).
        IF sy-subrc = 0 AND ls_tcode-range IS NOT INITIAL.
          lv_tcode = ls_tcode-range[ 1 ]-low.
        ENDIF.
      CATCH cx_rap_query_filter_no_range.
        "Defaults apply.
    ENDTRY.

    zcl_ado_st03_reader=>get_window(
      EXPORTING iv_from = lv_from
                iv_to   = lv_to
      IMPORTING et_user_tx = DATA(lt_all) ).

    IF lv_tcode IS NOT INITIAL.
      DELETE lt_all WHERE transaction_code <> lv_tcode.
    ENDIF.

    DATA(lv_total) = lines( lt_all ).
    IF io_request->is_total_numb_of_rec_requested( ).
      io_response->set_total_number_of_records( lv_total ).
    ENDIF.

    DATA(lo_paging) = io_request->get_paging( ).
    DATA(lv_offset)    = lo_paging->get_offset( ).
    DATA(lv_page_size) = lo_paging->get_page_size( ).
    IF lv_page_size < 0.
      lv_page_size = lv_total.
    ENDIF.
    DATA(lv_page_from) = lv_offset + 1.
    DATA(lv_page_to)   = lv_offset + lv_page_size.
    IF lv_page_from < 1. lv_page_from = 1. ENDIF.
    IF lv_page_to > lv_total. lv_page_to = lv_total. ENDIF.

    IF lv_page_from <= lv_page_to.
      LOOP AT lt_all ASSIGNING FIELD-SYMBOL(<ls_row>) FROM lv_page_from TO lv_page_to.
        APPEND VALUE ty_result(
          userkey         = <ls_row>-user_key
          transactioncode = <ls_row>-transaction_code
          periodfrom      = <ls_row>-period_from
          periodto        = <ls_row>-period_to
          executioncount  = <ls_row>-execution_count
          dialogstepcount = <ls_row>-dialog_step_count
          lastusedon      = <ls_row>-period_to
        ) TO lt_paged.
      ENDLOOP.
    ENDIF.

    IF io_request->is_data_requested( ).
      io_response->set_data( lt_paged ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
