CLASS zcl_ado_q_user_inv DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
ENDCLASS.


CLASS zcl_ado_q_user_inv IMPLEMENTATION.

  METHOD if_rap_query_provider~select.
    " USR02 user master, paged at the database, pseudonymised on the way
    " out. RoleCount is counted per page window over AGR_USERS (range of
    " the page's real user ids, before hashing).

    TYPES: BEGIN OF ty_result,
             userkey     TYPE c LENGTH 64,
             usertype    TYPE c LENGTH 1,
             usergroup   TYPE c LENGTH 12,
             validfrom   TYPE d,
             validto     TYPE d,
             lockflag    TYPE i,
             lastlogonon TYPE d,
             rolecount   TYPE i,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    TYPES ty_r_ustyp TYPE RANGE OF usr02-ustyp.
    DATA lt_r_ustyp TYPE ty_r_ustyp.
    LOOP AT zcl_ado_q_util=>ranges_of( io_request = io_request iv_name = 'USERTYPE' ) INTO DATA(ls_range).
      APPEND VALUE #( sign = ls_range-sign option = ls_range-option low = ls_range-low high = ls_range-high ) TO lt_r_ustyp.
    ENDLOOP.

    zcl_ado_q_util=>paging(
      EXPORTING io_request   = io_request
      IMPORTING ev_offset    = DATA(lv_offset)
                ev_page_size = DATA(lv_size) ).

    IF io_request->is_total_numb_of_rec_requested( ).
      SELECT COUNT(*) FROM usr02
        WHERE ustyp IN @lt_r_ustyp
        INTO @DATA(lv_total).
      io_response->set_total_number_of_records( lv_total ).
    ENDIF.

    IF io_request->is_data_requested( ).
      SELECT bname, ustyp, class, gltgv, gltgb, uflag, trdat
        FROM usr02
        WHERE ustyp IN @lt_r_ustyp
        ORDER BY bname
        INTO TABLE @DATA(lt_users)
        UP TO @lv_size ROWS OFFSET @lv_offset.

      " Role assignments of exactly this page's users.
      TYPES ty_r_uname TYPE RANGE OF agr_users-uname.
      DATA lt_r_uname TYPE ty_r_uname.
      LOOP AT lt_users INTO DATA(ls_user).
        APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_user-bname ) TO lt_r_uname.
      ENDLOOP.
      DATA lt_counts TYPE STANDARD TABLE OF usr02-bname WITH EMPTY KEY.
      TYPES: BEGIN OF ty_count,
               uname TYPE agr_users-uname,
               cnt   TYPE i,
             END OF ty_count.
      DATA lt_role_counts TYPE STANDARD TABLE OF ty_count WITH EMPTY KEY.
      IF lt_r_uname IS NOT INITIAL.
        SELECT uname, COUNT(*) AS cnt
          FROM agr_users
          WHERE uname IN @lt_r_uname
          GROUP BY uname
          INTO TABLE @lt_role_counts.
      ENDIF.

      LOOP AT lt_users INTO ls_user.
        DATA(lv_roles) = 0.
        READ TABLE lt_role_counts INTO DATA(ls_count) WITH KEY uname = ls_user-bname.
        IF sy-subrc = 0.
          lv_roles = ls_count-cnt.
        ENDIF.
        APPEND VALUE ty_result(
          userkey     = zcl_ado_pseudonym=>hash( CONV #( ls_user-bname ) )
          usertype    = ls_user-ustyp
          usergroup   = ls_user-class
          validfrom   = ls_user-gltgv
          validto     = ls_user-gltgb
          lockflag    = ls_user-uflag
          lastlogonon = ls_user-trdat
          rolecount   = lv_roles
        ) TO lt_result.
      ENDLOOP.
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
