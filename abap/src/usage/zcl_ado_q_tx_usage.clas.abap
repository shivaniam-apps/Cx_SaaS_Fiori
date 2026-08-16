CLASS zcl_ado_q_tx_usage DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
ENDCLASS.


CLASS zcl_ado_q_tx_usage IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " Live ST03N transaction profile. Materialises only the requested page
    " window (the ZSHVM spool-content lesson); the heavy aggregate itself is
    " session-cached in ZCL_ADO_ST03_READER.

    TYPES: BEGIN OF ty_result,
             transactioncode      TYPE c LENGTH 20,
             transactiontext      TYPE c LENGTH 120,
             programname          TYPE c LENGTH 40,
             applicationcomponent TYPE c LENGTH 40,
             periodfrom           TYPE d,
             periodto             TYPE d,
             executioncount       TYPE int8,
             dialogstepcount      TYPE int8,
             distinctusercount    TYPE i,
             totalresponsetimems  TYPE p LENGTH 16 DECIMALS 2,
             avgresponsetimems    TYPE p LENGTH 16 DECIMALS 2,
             totalcputimems       TYPE p LENGTH 16 DECIMALS 2,
             totaldbtimems        TYPE p LENGTH 16 DECIMALS 2,
             lastusedon           TYPE d,
           END OF ty_result.
    DATA lt_paged TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    " Window from $filter (PeriodFrom ge X / PeriodTo le Y); default 180 days.
    DATA(lv_from) = CONV d( sy-datum - 180 ).
    DATA(lv_to)   = sy-datum.
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
      CATCH cx_rap_query_filter_no_range.
        "Defaults apply.
    ENDTRY.

    zcl_ado_st03_reader=>get_window(
      EXPORTING iv_from = lv_from
                iv_to   = lv_to
      IMPORTING et_tx_usage = DATA(lt_all) ).

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
          transactioncode     = <ls_row>-transaction_code
          periodfrom          = <ls_row>-period_from
          periodto            = <ls_row>-period_to
          executioncount      = <ls_row>-execution_count
          dialogstepcount     = <ls_row>-dialog_step_count
          distinctusercount   = <ls_row>-distinct_user_cnt
          totalresponsetimems = <ls_row>-total_resp_ms
          avgresponsetimems   = <ls_row>-avg_resp_ms
          totalcputimems      = <ls_row>-total_cpu_ms
          totaldbtimems       = <ls_row>-total_db_ms
          lastusedon          = <ls_row>-period_to
        ) TO lt_paged.
      ENDLOOP.

      " Enrich descriptions/programs for the PAGE only (never the full set).
      IF lt_paged IS NOT INITIAL.
        SELECT tcode, pgmna FROM tstc
          FOR ALL ENTRIES IN @lt_paged
          WHERE tcode = @lt_paged-transactioncode
          INTO TABLE @DATA(lt_tstc).
        SELECT tcode, ttext FROM tstct
          FOR ALL ENTRIES IN @lt_paged
          WHERE tcode = @lt_paged-transactioncode AND sprsl = @sy-langu
          INTO TABLE @DATA(lt_tstct).
        LOOP AT lt_paged ASSIGNING FIELD-SYMBOL(<ls_page>).
          READ TABLE lt_tstct INTO DATA(ls_text) WITH KEY tcode = <ls_page>-transactioncode.
          IF sy-subrc = 0.
            <ls_page>-transactiontext = ls_text-ttext.
          ENDIF.
          READ TABLE lt_tstc INTO DATA(ls_tstc) WITH KEY tcode = <ls_page>-transactioncode.
          IF sy-subrc = 0.
            <ls_page>-programname = ls_tstc-pgmna.
          ENDIF.
        ENDLOOP.
      ENDIF.
    ENDIF.

    IF io_request->is_data_requested( ).
      io_response->set_data( lt_paged ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
