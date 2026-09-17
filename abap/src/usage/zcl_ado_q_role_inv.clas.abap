CLASS zcl_ado_q_role_inv DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.

  PRIVATE SECTION.
    TYPES ty_r_agr TYPE RANGE OF agr_define-agr_name.
    TYPES: BEGIN OF ty_count,
             agr_name TYPE agr_define-agr_name,
             cnt      TYPE i,
           END OF ty_count.
    TYPES ty_counts TYPE STANDARD TABLE OF ty_count WITH EMPTY KEY.

    CLASS-METHODS count_of
      IMPORTING it_counts     TYPE ty_counts
                iv_role       TYPE agr_define-agr_name
      RETURNING VALUE(rv_cnt) TYPE i.
ENDCLASS.


CLASS zcl_ado_q_role_inv IMPLEMENTATION.

  METHOD count_of.
    READ TABLE it_counts INTO DATA(ls_count) WITH KEY agr_name = iv_role.
    rv_cnt = COND #( WHEN sy-subrc = 0 THEN ls_count-cnt ELSE 0 ).
  ENDMETHOD.

  METHOD if_rap_query_provider~select.
    " AGR_DEFINE paged at the database; texts, composite flag and the
    " three counts are read for the page's roles only (range of the page).

    TYPES: BEGIN OF ty_result,
             rolename       TYPE c LENGTH 30,
             roletext       TYPE c LENGTH 80,
             roletype       TYPE c LENGTH 10,
             parentrole     TYPE c LENGTH 30,
             issapdelivered TYPE abap_boolean,
             menutcodecount TYPE i,
             authtcodecount TYPE i,
             usercount      TYPE i,
             changedon      TYPE d,
           END OF ty_result.
    DATA lt_result TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.

    DATA lt_r_role TYPE ty_r_agr.
    LOOP AT zcl_ado_q_util=>ranges_of( io_request = io_request iv_name = 'ROLENAME' ) INTO DATA(ls_range).
      APPEND VALUE #( sign = ls_range-sign option = ls_range-option low = ls_range-low high = ls_range-high ) TO lt_r_role.
    ENDLOOP.

    zcl_ado_q_util=>paging(
      EXPORTING io_request   = io_request
      IMPORTING ev_offset    = DATA(lv_offset)
                ev_page_size = DATA(lv_size) ).

    IF io_request->is_total_numb_of_rec_requested( ).
      SELECT COUNT(*) FROM agr_define
        WHERE agr_name IN @lt_r_role
        INTO @DATA(lv_total).
      io_response->set_total_number_of_records( lv_total ).
    ENDIF.

    IF io_request->is_data_requested( ).
      SELECT agr_name, parent_agr, change_dat
        FROM agr_define
        WHERE agr_name IN @lt_r_role
        ORDER BY agr_name
        INTO TABLE @DATA(lt_roles)
        UP TO @lv_size ROWS OFFSET @lv_offset.

      DATA lt_r_page TYPE ty_r_agr.
      LOOP AT lt_roles INTO DATA(ls_role).
        APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_role-agr_name ) TO lt_r_page.
      ENDLOOP.

      DATA lt_texts     TYPE STANDARD TABLE OF agr_texts WITH EMPTY KEY.
      DATA lt_composite TYPE STANDARD TABLE OF agr_define-agr_name WITH EMPTY KEY.
      DATA lt_menu      TYPE ty_counts.
      DATA lt_auth      TYPE ty_counts.
      DATA lt_users     TYPE ty_counts.
      IF lt_r_page IS NOT INITIAL.
        SELECT * FROM agr_texts
          WHERE agr_name IN @lt_r_page
            AND spras    = @sy-langu
            AND line     = '00000'
          INTO TABLE @lt_texts.
        " Composite roles are the parents in AGR_AGRS.
        SELECT DISTINCT agr_name FROM agr_agrs
          WHERE agr_name IN @lt_r_page
          INTO TABLE @lt_composite.
        SELECT agr_name, COUNT(*) AS cnt FROM agr_tcodes
          WHERE agr_name IN @lt_r_page
            AND type = 'TR'
          GROUP BY agr_name
          INTO TABLE @lt_menu.
        SELECT agr_name, COUNT(*) AS cnt FROM agr_1251
          WHERE agr_name IN @lt_r_page
            AND object  = 'S_TCODE'
            AND field   = 'TCD'
            AND deleted = ' '
          GROUP BY agr_name
          INTO TABLE @lt_auth.
        SELECT agr_name, COUNT(*) AS cnt FROM agr_users
          WHERE agr_name IN @lt_r_page
          GROUP BY agr_name
          INTO TABLE @lt_users.
      ENDIF.

      LOOP AT lt_roles INTO ls_role.
        DATA(lv_text) = VALUE agr_texts-text( ).
        READ TABLE lt_texts INTO DATA(ls_text) WITH KEY agr_name = ls_role-agr_name.
        IF sy-subrc = 0.
          lv_text = ls_text-text.
        ENDIF.
        DATA(lv_type) = COND string(
          WHEN line_exists( lt_composite[ table_line = ls_role-agr_name ] ) THEN 'COMPOSITE'
          WHEN ls_role-parent_agr IS NOT INITIAL                             THEN 'DERIVED'
          ELSE 'SINGLE' ).
        APPEND VALUE ty_result(
          rolename       = ls_role-agr_name
          roletext       = lv_text
          roletype       = lv_type
          parentrole     = ls_role-parent_agr
          issapdelivered = xsdbool( ls_role-agr_name CP 'SAP_*' )
          menutcodecount = count_of( it_counts = lt_menu  iv_role = ls_role-agr_name )
          authtcodecount = count_of( it_counts = lt_auth  iv_role = ls_role-agr_name )
          usercount      = count_of( it_counts = lt_users iv_role = ls_role-agr_name )
          changedon      = ls_role-change_dat
        ) TO lt_result.
      ENDLOOP.
      io_response->set_data( lt_result ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
