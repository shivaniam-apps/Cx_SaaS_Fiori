CLASS zcl_ado_cfg DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Add-on configuration in ZADO_CFG (client-specific, application
    " data: maintained per client with ZADO_CFG_INIT, never transported,
    " so a PROD secret never appears in DEV or in a transport).
    "
    " PSEUDONYM_SECRET is the salt behind ZCL_ADO_PSEUDONYM. It lives
    " only in the customer's system: the SaaS never sees it and therefore
    " cannot reverse or brute-force the pseudonyms it receives. Rotating
    " it changes every pseudonym, so historic snapshots no longer join.
    "---------------------------------------------------------------
    CONSTANTS gc_key_pseudonym_secret TYPE zado_cfg-cfg_key VALUE 'PSEUDONYM_SECRET'.

    CLASS-METHODS get
      IMPORTING iv_key          TYPE zado_cfg-cfg_key
      RETURNING VALUE(rv_value) TYPE string.

    CLASS-METHODS set
      IMPORTING iv_key   TYPE zado_cfg-cfg_key
                iv_value TYPE string.

    " Empty when no secret is configured (callers fall back safely).
    CLASS-METHODS pseudonym_secret
      RETURNING VALUE(rv_secret) TYPE string.

    " Creates the secret when absent; iv_force rotates an existing one.
    " Returns abap_true when a new secret was written.
    CLASS-METHODS generate_pseudonym_secret
      IMPORTING iv_force            TYPE abap_bool DEFAULT abap_false
      RETURNING VALUE(rv_generated) TYPE abap_bool.

  PRIVATE SECTION.
    " The secret is read once per session: the ST03N reader hashes one
    " user id per row and must not pay a SELECT each time.
    CLASS-DATA gv_secret        TYPE string.
    CLASS-DATA gv_secret_loaded TYPE abap_bool.
ENDCLASS.


CLASS zcl_ado_cfg IMPLEMENTATION.

  METHOD get.
    SELECT SINGLE cfg_value FROM zado_cfg
      WHERE cfg_key = @iv_key
      INTO @DATA(lv_value).
    IF sy-subrc = 0.
      rv_value = lv_value.
    ENDIF.
  ENDMETHOD.

  METHOD set.
    DATA lv_now TYPE timestampl.
    GET TIME STAMP FIELD lv_now.
    DATA(ls_row) = VALUE zado_cfg(
      cfg_key    = iv_key
      cfg_value  = iv_value
      changed_at = lv_now
      changed_by = sy-uname ).
    MODIFY zado_cfg FROM @ls_row.
    IF iv_key = gc_key_pseudonym_secret.
      CLEAR: gv_secret, gv_secret_loaded.
    ENDIF.
  ENDMETHOD.

  METHOD pseudonym_secret.
    IF gv_secret_loaded = abap_false.
      gv_secret        = get( gc_key_pseudonym_secret ).
      gv_secret_loaded = abap_true.
    ENDIF.
    rv_secret = gv_secret.
  ENDMETHOD.

  METHOD generate_pseudonym_secret.
    IF iv_force = abap_false AND pseudonym_secret( ) IS NOT INITIAL.
      rv_generated = abap_false.
      RETURN.
    ENDIF.
    TRY.
        " Two system UUIDs = 64 hex characters of system entropy.
        DATA(lv_secret) = to_lower( cl_system_uuid=>create_uuid_c32_static( ) )
                       && to_lower( cl_system_uuid=>create_uuid_c32_static( ) ).
      CATCH cx_uuid_error.
        rv_generated = abap_false.
        RETURN.
    ENDTRY.
    set( iv_key = gc_key_pseudonym_secret iv_value = lv_secret ).
    rv_generated = abap_true.
  ENDMETHOD.

ENDCLASS.
