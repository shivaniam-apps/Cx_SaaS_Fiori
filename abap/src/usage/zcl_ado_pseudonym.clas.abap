CLASS zcl_ado_pseudonym DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Pseudonymises SAP user ids before they leave the system:
    " SHA-256 over secret + tenant + uppercased user, truncated to 24
    " hex chars. Stable within one system, secret and tenant, so the
    " SaaS can aggregate per user without ever holding the identity.
    " Identified mode is an audited opt-in enforced ABOVE this class -
    " callers decide, this class only hashes.
    "
    " The secret comes from ZADO_CFG (PSEUDONYM_SECRET, created with
    " ZADO_CFG_INIT) and never leaves the system. Without a configured
    " secret the salt is system-derived (sy-sysid), as before. The
    " AdoptOps tenant id is mixed in so the same user yields different
    " pseudonyms for two tenants reading the same system.
    "
    " Compatibility: with no secret AND no tenant the input string is
    " byte-identical to the pre-A9 format, so existing pseudonyms in
    " unconfigured systems stay stable.
    "---------------------------------------------------------------
    CLASS-METHODS hash
      IMPORTING iv_value       TYPE string
                iv_tenant      TYPE string OPTIONAL
      RETURNING VALUE(rv_hash) TYPE string.
ENDCLASS.


CLASS zcl_ado_pseudonym IMPLEMENTATION.

  METHOD hash.
    DATA lv_hash TYPE string.
    DATA lv_data TYPE string.

    DATA(lv_secret) = zcl_ado_cfg=>pseudonym_secret( ).
    IF lv_secret IS INITIAL AND iv_tenant IS INITIAL.
      lv_data = |ZADO::{ sy-sysid }::{ to_upper( iv_value ) }|.
    ELSE.
      DATA(lv_salt) = COND string( WHEN lv_secret IS NOT INITIAL THEN lv_secret ELSE sy-sysid ).
      lv_data = |ZADO::{ lv_salt }::{ iv_tenant }::{ to_upper( iv_value ) }|.
    ENDIF.

    TRY.
        cl_abap_message_digest=>calculate_hash_for_char(
          EXPORTING
            if_algorithm  = 'SHA-256'
            if_data       = lv_data
          IMPORTING
            ef_hashstring = lv_hash ).
        rv_hash = to_lower( lv_hash(24) ).
      CATCH cx_abap_message_digest.
        " Never fall back to the clear value: an unusable pseudonym is
        " safer than a leaked identity.
        rv_hash = 'hash-unavailable'.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
