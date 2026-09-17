CLASS zcl_ado_q_role_tcodes DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
ENDCLASS.


CLASS zcl_ado_q_role_tcodes IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " One source per request (Source filter, default MENU), so each page
    " is a plain database window over one table:
    "   MENU -> AGR_TCODES (TYPE = 'TR')
    "   AUTH -> AGR_1251 (OBJECT S_TCODE, FIELD TCD, not deleted, no
    "           wildcard values - a '*' grants everything and is not a
    "           transaction reference).

    TYPES: BEGIN OF ty_result,
             rolename        TYPE c LENGTH 30,
             transactioncode TYPE c LENGTH 20,
             source          TYPE c LENGTH 10,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    TYPES ty_r_agr TYPE RANGE OF agr_tcodes-agr_name.
    DATA lt_r_role TYPE ty_r_agr.
    LOOP AT zcl_ado_q_util=>ranges_of( io_request = io_request iv_name = 'ROLENAME' ) INTO DATA(ls_range).
      APPEND VALUE #( sign = ls_range-sign option = ls_range-option low = ls_range-low high = ls_range-high ) TO lt_r_role.
    ENDLOOP.

    DATA lv_source TYPE c LENGTH 10 VALUE 'MENU'.
    LOOP AT zcl_ado_q_util=>ranges_of( io_request = io_request iv_name = 'SOURCE' ) INTO DATA(ls_source).
      IF ls_source-option = 'EQ' AND to_upper( ls_source-low ) = 'AUTH'.
        lv_source = 'AUTH'.
      ENDIF.
    ENDLOOP.

    zcl_ado_q_util=>paging(
      EXPORTING io_request   = io_request
      IMPORTING ev_offset    = DATA(lv_offset)
                ev_page_size = DATA(lv_size) ).

    DATA lv_total TYPE i.
    IF lv_source = 'AUTH'.
      IF io_request->is_total_numb_of_rec_requested( ).
        SELECT COUNT(*) FROM agr_1251
          WHERE agr_name IN @lt_r_role
            AND object  = 'S_TCODE'
            AND field   = 'TCD'
            AND deleted = ' '
            AND low    <> '*'
          INTO @lv_total.
        io_response->set_total_number_of_records( lv_total ).
      ENDIF.
      IF io_request->is_data_requested( ).
        SELECT agr_name, low
          FROM agr_1251
          WHERE agr_name IN @lt_r_role
            AND object  = 'S_TCODE'
            AND field   = 'TCD'
            AND deleted = ' '
            AND low    <> '*'
          ORDER BY agr_name, low
          INTO TABLE @DATA(lt_auth)
          UP TO @lv_size ROWS OFFSET @lv_offset.
        LOOP AT lt_auth INTO DATA(ls_auth).
          APPEND VALUE ty_result(
            rolename        = ls_auth-agr_name
            transactioncode = ls_auth-low
            source          = 'AUTH'
          ) TO lt_result.
        ENDLOOP.
      ENDIF.
    ELSE.
      IF io_request->is_total_numb_of_rec_requested( ).
        SELECT COUNT(*) FROM agr_tcodes
          WHERE agr_name IN @lt_r_role
            AND type = 'TR'
          INTO @lv_total.
        io_response->set_total_number_of_records( lv_total ).
      ENDIF.
      IF io_request->is_data_requested( ).
        SELECT agr_name, tcode
          FROM agr_tcodes
          WHERE agr_name IN @lt_r_role
            AND type = 'TR'
          ORDER BY agr_name, tcode
          INTO TABLE @DATA(lt_menu)
          UP TO @lv_size ROWS OFFSET @lv_offset.
        LOOP AT lt_menu INTO DATA(ls_menu).
          APPEND VALUE ty_result(
            rolename        = ls_menu-agr_name
            transactioncode = ls_menu-tcode
            source          = 'MENU'
          ) TO lt_result.
        ENDLOOP.
      ENDIF.
    ENDIF.

    IF io_request->is_data_requested( ).
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
