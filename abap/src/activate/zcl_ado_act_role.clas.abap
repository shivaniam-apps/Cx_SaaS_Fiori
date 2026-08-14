CLASS zcl_ado_act_role DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " PFCG role write path. FMs confirmed on A4H and RD1
    " (docu/06-s4-integration/api-matrix.md):
    " - PRGN_RFC_CREATE_ACTIVITY_GROUP: role + menu + profile in one
    "   call, TRKORR in/out. HIERARCHY_NODES (TYPE SMENSAPNEW) is the
    "   expected write path for catalog/space menu nodes - the exact
    "   node shape for spaces is an OPEN CHECK on RD1 (api-matrix,
    "   headline 3 follow-up).
    " - PRGN_AUTO_GENERATE_PROFILE_NEW: profile generation, TRKORR,
    "   granular exceptions.
    " - User assignment: BAPI_USER_ACTGROUPS_ASSIGN followed by
    "   PRGN_UPDATE_DATABASE (working assumption per matrix headline 6;
    "   PFCG_TIME_DEPENDENCY does not exist on either system).
    "
    " SAP_BR_* business role menus are AGR_HIER-only; anything this
    " class writes goes into Z_ADO_* customer roles, never into SAP
    " shipped roles.
    "---------------------------------------------------------------

    CLASS-METHODS role_exists
      IMPORTING iv_role          TYPE agr_name
      RETURNING VALUE(rv_exists) TYPE abap_bool.

    " Create the role if absent (verify-first; SKIPPED when present).
    CLASS-METHODS create_role
      IMPORTING iv_role          TYPE agr_name
                iv_text          TYPE string
                iv_trkorr        TYPE trkorr OPTIONAL
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

    CLASS-METHODS generate_profile
      IMPORTING iv_role          TYPE agr_name
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

    " Assign the role to users; missing users are reported per row in
    " the BAPI return, the step degrades to WARNING, never FAILED.
    CLASS-METHODS assign_users
      IMPORTING iv_role          TYPE agr_name
                it_users         TYPE string_table
      RETURNING VALUE(rs_result) TYPE zif_ado_act_step=>ty_result.

ENDCLASS.


CLASS zcl_ado_act_role IMPLEMENTATION.

  METHOD role_exists.
    SELECT SINGLE @abap_true FROM agr_define
      WHERE agr_name = @iv_role
      INTO @rv_exists.
  ENDMETHOD.

  METHOD create_role.
    IF role_exists( iv_role ) = abap_true.
      rs_result-status         = zif_ado_act_step=>c_status-skipped.
      rs_result-exists_already = abap_true.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |Role { iv_role } already exists - step skipped (idempotent).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    DATA lv_role   TYPE agr_name.
    DATA lv_text   TYPE agr_title.
    DATA lv_trkorr TYPE trkorr.
    " DEFAULT KEY, not EMPTY KEY: classic function groups hand their TABLES
    " parameters to PERFORMs typed with default-key table types - an EMPTY
    " KEY table dumps with PERFORM_CONFLICT_TAB_TYPE (seen on RD1).
    DATA lt_return TYPE STANDARD TABLE OF bapiret2 WITH DEFAULT KEY.
    lv_role   = iv_role.
    lv_text   = iv_text.
    lv_trkorr = iv_trkorr.

    " Signature verified in RD1 (SE37): the text parameter is
    " ACTIVITY_GROUP_TEXT, the transport goes IN as REQUEST and comes BACK
    " as NEW_REQUEST - there is no CHANGING clause. NO_DIALOG defaults 'X'.
    " Single roles only; collective roles use PRGN_RFC_CREATE_AGR_MULTIPLE.
    CALL FUNCTION 'PRGN_RFC_CREATE_ACTIVITY_GROUP'
      EXPORTING
        activity_group      = lv_role
        activity_group_text = lv_text
        request             = lv_trkorr
      IMPORTING
        new_request         = lv_trkorr
      TABLES
        return              = lt_return
      EXCEPTIONS
        OTHERS              = 1.
    IF sy-subrc <> 0.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |PRGN_RFC_CREATE_ACTIVITY_GROUP failed for { iv_role } (subrc { sy-subrc }).| )
        TO rs_result-messages.
      APPEND LINES OF lt_return TO rs_result-messages.
      RETURN.
    ENDIF.
    APPEND LINES OF lt_return TO rs_result-messages.

    " Verify-after.
    IF role_exists( iv_role ) = abap_true.
      rs_result-status = zif_ado_act_step=>c_status-success.
      rs_result-trkorr = lv_trkorr.
      APPEND VALUE bapiret2(
          type    = 'S'
          message = |Role { iv_role } created{ COND #( WHEN lv_trkorr IS NOT INITIAL THEN | on transport { lv_trkorr }| ) }.| )
        TO rs_result-messages.
    ELSE.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |Post-verification failed: role { iv_role } not found after create.| )
        TO rs_result-messages.
    ENDIF.
  ENDMETHOD.

  METHOD generate_profile.
    IF role_exists( iv_role ) = abap_false.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |Role { iv_role } does not exist - profile generation impossible.| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    DATA lv_role TYPE agr_name.
    lv_role = iv_role.
    CALL FUNCTION 'PRGN_AUTO_GENERATE_PROFILE_NEW'
      EXPORTING
        activity_group = lv_role
      EXCEPTIONS
        OTHERS         = 1.
    IF sy-subrc <> 0.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |PRGN_AUTO_GENERATE_PROFILE_NEW failed for { iv_role } (subrc { sy-subrc }).| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    rs_result-status = zif_ado_act_step=>c_status-success.
    APPEND VALUE bapiret2(
        type    = 'S'
        message = |Authorization profile generated for { iv_role }.| )
      TO rs_result-messages.
  ENDMETHOD.

  METHOD assign_users.
    IF role_exists( iv_role ) = abap_false.
      rs_result-status = zif_ado_act_step=>c_status-failed.
      APPEND VALUE bapiret2(
          type    = 'E'
          message = |Role { iv_role } does not exist - no assignments possible.| )
        TO rs_result-messages.
      RETURN.
    ENDIF.

    DATA lv_failed TYPE i.
    LOOP AT it_users INTO DATA(lv_user_raw).
      DATA lv_user TYPE xubname.
      " DEFAULT KEY for TABLES parameters (see create_role).
      DATA lt_agrs TYPE STANDARD TABLE OF bapiagr WITH DEFAULT KEY.
      DATA lt_ret  TYPE STANDARD TABLE OF bapiret2 WITH DEFAULT KEY.
      CLEAR: lt_agrs, lt_ret.
      lv_user = lv_user_raw.
      APPEND VALUE bapiagr( agr_name = iv_role ) TO lt_agrs.

      CALL FUNCTION 'BAPI_USER_ACTGROUPS_ASSIGN'
        EXPORTING
          username       = lv_user
        TABLES
          activitygroups = lt_agrs
          return         = lt_ret
        EXCEPTIONS
          OTHERS         = 1.
      IF sy-subrc <> 0 OR line_exists( lt_ret[ type = 'E' ] ).
        lv_failed = lv_failed + 1.
        APPEND VALUE bapiret2(
            type    = 'W'
            message = |Assignment of { iv_role } to { lv_user } failed.| )
          TO rs_result-messages.
        APPEND LINES OF lt_ret TO rs_result-messages.
      ENDIF.
    ENDLOOP.

    " Master-data compare: PFCG_TIME_DEPENDENCY is missing on both
    " systems; PRGN_UPDATE_DATABASE is the confirmed-present path.
    CALL FUNCTION 'PRGN_UPDATE_DATABASE'
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0.
      APPEND VALUE bapiret2(
          type    = 'W'
          message = |PRGN_UPDATE_DATABASE returned subrc { sy-subrc } - run RHAUTUPD_NEW as fallback.| )
        TO rs_result-messages.
    ENDIF.

    rs_result-status = COND #(
      WHEN lv_failed = lines( it_users ) AND lv_failed > 0 THEN zif_ado_act_step=>c_status-failed
      WHEN lv_failed > 0                                   THEN zif_ado_act_step=>c_status-warning
      ELSE zif_ado_act_step=>c_status-success ).
    APPEND VALUE bapiret2(
        type    = 'S'
        message = |{ lines( it_users ) - lv_failed } of { lines( it_users ) } user(s) assigned to { iv_role }.| )
      TO rs_result-messages.
  ENDMETHOD.

ENDCLASS.
