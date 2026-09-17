CLASS zcl_ado_q_role_users DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
ENDCLASS.


CLASS zcl_ado_q_role_users IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " AGR_USERS paged at the database (role, user order), pseudonymised
    " on the way out.

    TYPES: BEGIN OF ty_result,
             rolename  TYPE c LENGTH 30,
             userkey   TYPE c LENGTH 64,
             validfrom TYPE d,
             validto   TYPE d,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    TYPES ty_r_agr TYPE RANGE OF agr_users-agr_name.
    DATA lt_r_role TYPE ty_r_agr.
    LOOP AT zcl_ado_q_util=>ranges_of( io_request = io_request iv_name = 'ROLENAME' ) INTO DATA(ls_range).
      APPEND VALUE #( sign = ls_range-sign option = ls_range-option low = ls_range-low high = ls_range-high ) TO lt_r_role.
    ENDLOOP.

    zcl_ado_q_util=>paging(
      EXPORTING io_request   = io_request
      IMPORTING ev_offset    = DATA(lv_offset)
                ev_page_size = DATA(lv_size) ).

    IF io_request->is_total_numb_of_rec_requested( ).
      SELECT COUNT(*) FROM agr_users
        WHERE agr_name IN @lt_r_role
        INTO @DATA(lv_total).
      io_response->set_total_number_of_records( lv_total ).
    ENDIF.

    IF io_request->is_data_requested( ).
      SELECT agr_name, uname, from_dat, to_dat
        FROM agr_users
        WHERE agr_name IN @lt_r_role
        ORDER BY agr_name, uname
        INTO TABLE @DATA(lt_rows)
        UP TO @lv_size ROWS OFFSET @lv_offset.
      LOOP AT lt_rows INTO DATA(ls_row).
        APPEND VALUE ty_result(
          rolename  = ls_row-agr_name
          userkey   = zcl_ado_pseudonym=>hash( CONV #( ls_row-uname ) )
          validfrom = ls_row-from_dat
          validto   = ls_row-to_dat
        ) TO lt_result.
      ENDLOOP.
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
