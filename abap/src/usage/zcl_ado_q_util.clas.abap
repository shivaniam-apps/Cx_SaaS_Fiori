CLASS zcl_ado_q_util DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    "---------------------------------------------------------------
    " Shared helpers for the ZADO custom-entity query providers that
    " page at the DATABASE (inventory readers, S8): the page window and
    " the filter ranges come from the RAP request, the SELECT carries
    " ORDER BY + OFFSET + UP TO so only the requested rows materialise.
    "---------------------------------------------------------------

    " Page window: offset and size. A missing $top (page size -1) is
    " capped at iv_max so a client can never pull a whole AGR_USERS.
    CLASS-METHODS paging
      IMPORTING io_request   TYPE REF TO if_rap_query_request
                iv_max       TYPE i DEFAULT 5000
      EXPORTING ev_offset    TYPE i
                ev_page_size TYPE i.

    " Filter ranges for one element (uppercase name); empty when the
    " request carries no usable filter for it.
    CLASS-METHODS ranges_of
      IMPORTING io_request      TYPE REF TO if_rap_query_request
                iv_name         TYPE string
      RETURNING VALUE(rt_range) TYPE if_rap_query_filter=>tt_range_option.

ENDCLASS.


CLASS zcl_ado_q_util IMPLEMENTATION.

  METHOD paging.
    DATA(lo_paging) = io_request->get_paging( ).
    ev_offset    = lo_paging->get_offset( ).
    ev_page_size = lo_paging->get_page_size( ).
    IF ev_offset < 0.
      ev_offset = 0.
    ENDIF.
    IF ev_page_size < 0 OR ev_page_size > iv_max.
      ev_page_size = iv_max.
    ENDIF.
  ENDMETHOD.

  METHOD ranges_of.
    CLEAR rt_range.
    TRY.
        DATA(lt_ranges) = io_request->get_filter( )->get_as_ranges( ).
        READ TABLE lt_ranges WITH KEY name = to_upper( iv_name ) INTO DATA(ls_pair).
        IF sy-subrc = 0.
          rt_range = ls_pair-range.
        ENDIF.
      CATCH cx_rap_query_filter_no_range.
        CLEAR rt_range.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
