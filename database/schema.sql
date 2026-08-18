--
-- PostgreSQL database dump
--

\restrict sXjP7hk4mRNdoyoWiacnACvY1DtJ7OnmNqZ3N4roidb5f3sMVbXu7gOtETz5QdL

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: experiment; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA experiment;


--
-- Name: login; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA login;


--
-- Name: osmchange; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA osmchange;


--
-- Name: roadinfo; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA roadinfo;


--
-- Name: SCHEMA roadinfo; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA roadinfo IS '道情報投稿機能のためのスキーマ';


--
-- Name: tactile; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA tactile;


--
-- Name: SCHEMA tactile; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA tactile IS '点字ブロックマップ機能のためのスキーマ';


--
-- Name: prevent_fitting_history_mutation(); Type: FUNCTION; Schema: experiment; Owner: -
--

CREATE FUNCTION experiment.prevent_fitting_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin raise exception 'fitting_comparisons is append-only'; end $$;


--
-- Name: prevent_consent_mutation(); Type: FUNCTION; Schema: login; Owner: -
--

CREATE FUNCTION login.prevent_consent_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
          RAISE EXCEPTION 'User consent history is append-only';
        END $$;


--
-- Name: prevent_osm_audit_mutation(); Type: FUNCTION; Schema: login; Owner: -
--

CREATE FUNCTION login.prevent_osm_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
          RAISE EXCEPTION 'OSM connection audit is append-only';
        END $$;


--
-- Name: prevent_osm_service_audit_mutation(); Type: FUNCTION; Schema: login; Owner: -
--

CREATE FUNCTION login.prevent_osm_service_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'OSM service account audit is append-only'; END $$;


--
-- Name: prevent_history_mutation(); Type: FUNCTION; Schema: osmchange; Owner: -
--

CREATE FUNCTION osmchange.prevent_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        RAISE EXCEPTION 'OSM change history is append-only';
      END $$;


--
-- Name: prevent_record_link_delete(); Type: FUNCTION; Schema: osmchange; Owner: -
--

CREATE FUNCTION osmchange.prevent_record_link_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'OSM record links cannot be deleted';
    END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_record_audit; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.api_record_audit (
    event_id uuid NOT NULL,
    experiment_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_user_id bigint NOT NULL,
    payload_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_record_audit_event_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'deleted'::text])))
);


--
-- Name: api_records; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.api_records (
    experiment_id uuid NOT NULL,
    label text NOT NULL,
    payload jsonb NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fitting_comparisons; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.fitting_comparisons (
    id bigint NOT NULL,
    experiment_session_uuid text,
    user_id text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_lat double precision NOT NULL,
    raw_lng double precision NOT NULL,
    valhalla_lat double precision,
    valhalla_lng double precision,
    valhalla_way_id bigint,
    valhalla_distance_m double precision,
    browser_lat double precision,
    browser_lng double precision,
    browser_way_id bigint,
    browser_way_version integer,
    browser_distance_m double precision,
    browser_priority text,
    result_distance_m double precision,
    way_match boolean,
    browser_connected boolean,
    valhalla_duration_ms integer,
    browser_duration_ms integer,
    status text NOT NULL,
    error_message text,
    client_version text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fitting_comparisons_id_seq; Type: SEQUENCE; Schema: experiment; Owner: -
--

CREATE SEQUENCE experiment.fitting_comparisons_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fitting_comparisons_id_seq; Type: SEQUENCE OWNED BY; Schema: experiment; Owner: -
--

ALTER SEQUENCE experiment.fitting_comparisons_id_seq OWNED BY experiment.fitting_comparisons.id;


--
-- Name: fitting_outlier_maps; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.fitting_outlier_maps (
    batch_id uuid NOT NULL,
    source_session_digest text NOT NULL,
    started_at timestamp with time zone,
    raw_point_count integer NOT NULL,
    difference_m double precision NOT NULL,
    connected boolean NOT NULL,
    browser_way_ids jsonb NOT NULL,
    valhalla_way_ids jsonb NOT NULL,
    raw_points jsonb NOT NULL,
    browser_paths jsonb NOT NULL,
    valhalla_paths jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fitting_replay_runs; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.fitting_replay_runs (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    requested_by text NOT NULL,
    raw_point_count integer NOT NULL,
    network_way_count integer NOT NULL,
    browser_result jsonb NOT NULL,
    valhalla_result jsonb,
    score jsonb NOT NULL,
    status text NOT NULL,
    osm_sent boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gps_replay_runs; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.gps_replay_runs (
    replay_id uuid NOT NULL,
    session_id uuid NOT NULL,
    requested_by text NOT NULL,
    event_count integer NOT NULL,
    historical_way_ids jsonb NOT NULL,
    replay_result jsonb NOT NULL,
    status text NOT NULL,
    osm_sent boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: production_fitting_batch_results; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.production_fitting_batch_results (
    batch_id uuid NOT NULL,
    source_session_digest text NOT NULL,
    started_at timestamp with time zone,
    raw_point_count integer NOT NULL,
    status text NOT NULL,
    browser_result jsonb,
    valhalla_result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: production_fitting_batches; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.production_fitting_batches (
    batch_id uuid NOT NULL,
    total_records integer NOT NULL,
    eligible_records integer NOT NULL,
    status text NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: production_record_imports; Type: TABLE; Schema: experiment; Owner: -
--

CREATE TABLE experiment.production_record_imports (
    import_id uuid NOT NULL,
    development_session_id uuid NOT NULL,
    source_session_digest text NOT NULL,
    raw_point_count integer NOT NULL,
    matched_point_count integer NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    note text NOT NULL
);


--
-- Name: email_verification_tokens; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.email_verification_tokens (
    token text NOT NULL,
    user_id integer NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: osm_connection_audit; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.osm_connection_audit (
    audit_id bigint NOT NULL,
    user_id bigint,
    event_type text NOT NULL,
    osm_user_id bigint,
    osm_display_name text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: osm_connection_audit_audit_id_seq; Type: SEQUENCE; Schema: login; Owner: -
--

CREATE SEQUENCE login.osm_connection_audit_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: osm_connection_audit_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: login; Owner: -
--

ALTER SEQUENCE login.osm_connection_audit_audit_id_seq OWNED BY login.osm_connection_audit.audit_id;


--
-- Name: osm_connections; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.osm_connections (
    user_id bigint NOT NULL,
    osm_user_id bigint NOT NULL,
    osm_display_name text NOT NULL,
    access_token_encrypted text NOT NULL,
    granted_scope text NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    connected_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_verified_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT osm_connections_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'revoked'::text, 'invalid'::text])))
);


--
-- Name: osm_oauth_states; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.osm_oauth_states (
    state_hash text NOT NULL,
    user_id bigint NOT NULL,
    code_verifier_encrypted text NOT NULL,
    return_url text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    flow_mode text DEFAULT 'redirect'::text NOT NULL
);


--
-- Name: osm_service_account; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.osm_service_account (
    singleton boolean DEFAULT true NOT NULL,
    osm_user_id bigint NOT NULL,
    osm_display_name text NOT NULL,
    access_token_encrypted text NOT NULL,
    granted_scope text NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    connected_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_verified_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT osm_service_account_singleton_check CHECK (singleton),
    CONSTRAINT osm_service_account_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'invalid'::text, 'revoked'::text])))
);


--
-- Name: osm_service_account_audit; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.osm_service_account_audit (
    audit_id bigint NOT NULL,
    event_type text NOT NULL,
    osm_user_id bigint,
    osm_display_name text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: osm_service_account_audit_audit_id_seq; Type: SEQUENCE; Schema: login; Owner: -
--

CREATE SEQUENCE login.osm_service_account_audit_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: osm_service_account_audit_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: login; Owner: -
--

ALTER SEQUENCE login.osm_service_account_audit_audit_id_seq OWNED BY login.osm_service_account_audit.audit_id;


--
-- Name: osm_service_oauth_states; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.osm_service_oauth_states (
    state_hash text NOT NULL,
    code_verifier_encrypted text NOT NULL,
    expected_display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: user_auth_providers; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.user_auth_providers (
    auth_id integer NOT NULL,
    user_id bigint NOT NULL,
    provider character varying(20) NOT NULL,
    provider_user_id text,
    email character varying(255),
    password_hash text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_uap_fields_by_provider CHECK (((((provider)::text = 'email'::text) AND (email IS NOT NULL) AND (password_hash IS NOT NULL) AND (provider_user_id IS NULL)) OR (((provider)::text = 'google'::text) AND (provider_user_id IS NOT NULL) AND (password_hash IS NULL)))),
    CONSTRAINT user_auth_providers_provider_check CHECK (((provider)::text = ANY (ARRAY[('email'::character varying)::text, ('google'::character varying)::text])))
);


--
-- Name: user_auth_providers_auth_id_seq; Type: SEQUENCE; Schema: login; Owner: -
--

CREATE SEQUENCE login.user_auth_providers_auth_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_auth_providers_auth_id_seq; Type: SEQUENCE OWNED BY; Schema: login; Owner: -
--

ALTER SEQUENCE login.user_auth_providers_auth_id_seq OWNED BY login.user_auth_providers.auth_id;


--
-- Name: user_consents; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.user_consents (
    consent_id bigint NOT NULL,
    user_id bigint NOT NULL,
    terms_version text NOT NULL,
    privacy_version text NOT NULL,
    accepted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    acceptance_source text NOT NULL
);


--
-- Name: user_consents_consent_id_seq; Type: SEQUENCE; Schema: login; Owner: -
--

CREATE SEQUENCE login.user_consents_consent_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_consents_consent_id_seq; Type: SEQUENCE OWNED BY; Schema: login; Owner: -
--

ALTER SEQUENCE login.user_consents_consent_id_seq OWNED BY login.user_consents.consent_id;


--
-- Name: user_sessions; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.user_sessions (
    session_id text NOT NULL,
    user_id bigint NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: login; Owner: -
--

CREATE TABLE login.users (
    user_id bigint NOT NULL,
    username character varying(50),
    icon_url text,
    total_tactile_length numeric(10,3) DEFAULT 0,
    total_road_posts integer DEFAULT 0,
    total_hearts integer DEFAULT 0,
    is_active boolean DEFAULT true,
    email_verified boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_login_at timestamp without time zone,
    is_pro boolean DEFAULT false,
    is_guest boolean DEFAULT false
);


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: login; Owner: -
--

CREATE SEQUENCE login.users_user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_user_id_seq; Type: SEQUENCE OWNED BY; Schema: login; Owner: -
--

ALTER SEQUENCE login.users_user_id_seq OWNED BY login.users.user_id;


--
-- Name: audit_events; Type: TABLE; Schema: osmchange; Owner: -
--

CREATE TABLE osmchange.audit_events (
    event_id bigint NOT NULL,
    plan_id uuid,
    event_type text NOT NULL,
    actor_user_id bigint,
    request_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_events_event_id_seq; Type: SEQUENCE; Schema: osmchange; Owner: -
--

CREATE SEQUENCE osmchange.audit_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: osmchange; Owner: -
--

ALTER SEQUENCE osmchange.audit_events_event_id_seq OWNED BY osmchange.audit_events.event_id;


--
-- Name: change_plans; Type: TABLE; Schema: osmchange; Owner: -
--

CREATE TABLE osmchange.change_plans (
    plan_id uuid NOT NULL,
    operation_type text NOT NULL,
    created_by bigint NOT NULL,
    source_plan_id uuid,
    summary text NOT NULL,
    elements jsonb NOT NULL,
    client_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT change_plans_operation_type_check CHECK ((operation_type = ANY (ARRAY['merge'::text, 'delete'::text, 'revert'::text]))),
    CONSTRAINT change_plans_status_check CHECK ((status = 'draft'::text))
);


--
-- Name: execution_attempts; Type: TABLE; Schema: osmchange; Owner: -
--

CREATE TABLE osmchange.execution_attempts (
    attempt_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    action text NOT NULL,
    actor_user_id bigint NOT NULL,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_attempts_action_check CHECK ((action = ANY (ARRAY['execute'::text, 'execute-revert'::text])))
);


--
-- Name: opt_out_rules; Type: TABLE; Schema: osmchange; Owner: -
--

CREATE TABLE osmchange.opt_out_rules (
    rule_id uuid NOT NULL,
    rule_type text NOT NULL,
    rule_value jsonb NOT NULL,
    reason text NOT NULL,
    source_url text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT opt_out_rules_rule_type_check CHECK ((rule_type = ANY (ARRAY['way'::text, 'osm_user'::text, 'region'::text, 'tag'::text])))
);


--
-- Name: record_links; Type: TABLE; Schema: osmchange; Owner: -
--

CREATE TABLE osmchange.record_links (
    record_id uuid NOT NULL,
    created_by bigint NOT NULL,
    merge_plan_id uuid NOT NULL,
    merge_changeset_id bigint,
    revert_plan_id uuid,
    revert_changeset_id bigint,
    osm_status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT record_links_osm_status_check CHECK ((osm_status = ANY (ARRAY['draft'::text, 'merged'::text, 'revert_draft'::text, 'reverted'::text, 'failed'::text, 'conflict'::text])))
);


--
-- Name: road_info_media; Type: TABLE; Schema: roadinfo; Owner: -
--

CREATE TABLE roadinfo.road_info_media (
    id bigint NOT NULL,
    note_id bigint NOT NULL,
    media_type text DEFAULT 'image'::text NOT NULL,
    url text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL
);


--
-- Name: road_info_media_id_seq; Type: SEQUENCE; Schema: roadinfo; Owner: -
--

CREATE SEQUENCE roadinfo.road_info_media_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: road_info_media_id_seq; Type: SEQUENCE OWNED BY; Schema: roadinfo; Owner: -
--

ALTER SEQUENCE roadinfo.road_info_media_id_seq OWNED BY roadinfo.road_info_media.id;


--
-- Name: road_info_note; Type: TABLE; Schema: roadinfo; Owner: -
--

CREATE TABLE roadinfo.road_info_note (
    id bigint NOT NULL,
    point_id bigint NOT NULL,
    body text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL
);


--
-- Name: road_info_note_id_seq; Type: SEQUENCE; Schema: roadinfo; Owner: -
--

CREATE SEQUENCE roadinfo.road_info_note_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: road_info_note_id_seq; Type: SEQUENCE OWNED BY; Schema: roadinfo; Owner: -
--

ALTER SEQUENCE roadinfo.road_info_note_id_seq OWNED BY roadinfo.road_info_note.id;


--
-- Name: road_info_point; Type: TABLE; Schema: roadinfo; Owner: -
--

CREATE TABLE roadinfo.road_info_point (
    id bigint NOT NULL,
    geom public.geography(Point,4326) NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT road_info_point_status_check CHECK ((status = ANY (ARRAY['active'::text, 'hidden'::text, 'deleted'::text, 'needs_review'::text])))
);


--
-- Name: road_info_point_id_seq; Type: SEQUENCE; Schema: roadinfo; Owner: -
--

CREATE SEQUENCE roadinfo.road_info_point_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: road_info_point_id_seq; Type: SEQUENCE OWNED BY; Schema: roadinfo; Owner: -
--

ALTER SEQUENCE roadinfo.road_info_point_id_seq OWNED BY roadinfo.road_info_point.id;


--
-- Name: road_info_point_tag; Type: TABLE; Schema: roadinfo; Owner: -
--

CREATE TABLE roadinfo.road_info_point_tag (
    point_id bigint NOT NULL,
    tag_id bigint NOT NULL
);


--
-- Name: road_info_tag; Type: TABLE; Schema: roadinfo; Owner: -
--

CREATE TABLE roadinfo.road_info_tag (
    id bigint NOT NULL,
    code text NOT NULL,
    label_ja text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: road_info_tag_id_seq; Type: SEQUENCE; Schema: roadinfo; Owner: -
--

CREATE SEQUENCE roadinfo.road_info_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: road_info_tag_id_seq; Type: SEQUENCE OWNED BY; Schema: roadinfo; Owner: -
--

ALTER SEQUENCE roadinfo.road_info_tag_id_seq OWNED BY roadinfo.road_info_tag.id;


--
-- Name: submission_keys; Type: TABLE; Schema: roadinfo; Owner: -
--

CREATE TABLE roadinfo.submission_keys (
    user_id bigint NOT NULL,
    submission_key text NOT NULL,
    response_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gps_matched; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.gps_matched (
    id bigint NOT NULL,
    session_id uuid,
    ts timestamp without time zone NOT NULL,
    geom public.geography(Point,4326) NOT NULL,
    edge_id bigint,
    confidence double precision
);


--
-- Name: gps_matched_id_seq; Type: SEQUENCE; Schema: tactile; Owner: -
--

CREATE SEQUENCE tactile.gps_matched_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gps_matched_id_seq; Type: SEQUENCE OWNED BY; Schema: tactile; Owner: -
--

ALTER SEQUENCE tactile.gps_matched_id_seq OWNED BY tactile.gps_matched.id;


--
-- Name: gps_raw; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.gps_raw (
    id bigint NOT NULL,
    session_id uuid,
    ts timestamp without time zone NOT NULL,
    geom public.geography(Point,4326) NOT NULL,
    accuracy double precision
);


--
-- Name: gps_raw_id_seq; Type: SEQUENCE; Schema: tactile; Owner: -
--

CREATE SEQUENCE tactile.gps_raw_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gps_raw_id_seq; Type: SEQUENCE OWNED BY; Schema: tactile; Owner: -
--

ALTER SEQUENCE tactile.gps_raw_id_seq OWNED BY tactile.gps_raw.id;


--
-- Name: session_path_edges; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.session_path_edges (
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    edge_id bigint NOT NULL
);


--
-- Name: session_paths; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.session_paths (
    session_id uuid NOT NULL,
    geom public.geography(LineString,4326) NOT NULL,
    source text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: session_tags; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.session_tags (
    session_id uuid NOT NULL,
    tag_id bigint NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.sessions (
    session_id uuid NOT NULL,
    started_at timestamp without time zone NOT NULL,
    ended_at timestamp without time zone,
    user_id bigint,
    memo text,
    is_active boolean DEFAULT true
);


--
-- Name: tags; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.tags (
    id bigint NOT NULL,
    code text NOT NULL,
    label_ja text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    osm_exportable boolean DEFAULT false NOT NULL,
    display_color text DEFAULT 'red'::text NOT NULL,
    system_defined boolean DEFAULT false NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: tactile; Owner: -
--

CREATE SEQUENCE tactile.tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: tactile; Owner: -
--

ALTER SEQUENCE tactile.tags_id_seq OWNED BY tactile.tags.id;


--
-- Name: way_snapshots; Type: TABLE; Schema: tactile; Owner: -
--

CREATE TABLE tactile.way_snapshots (
    snapshot_id uuid NOT NULL,
    record_id uuid NOT NULL,
    segment_order integer NOT NULL,
    way_id bigint NOT NULL,
    way_version integer NOT NULL,
    node_ids jsonb NOT NULL,
    full_coordinates jsonb NOT NULL,
    segment_from jsonb NOT NULL,
    segment_to jsonb NOT NULL,
    original_tags jsonb NOT NULL,
    relation_context jsonb DEFAULT '[]'::jsonb NOT NULL,
    tactile_side text,
    planned_tags jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'browser_osm_snapshot'::text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT way_snapshots_segment_order_check CHECK ((segment_order >= 0)),
    CONSTRAINT way_snapshots_tactile_side_check CHECK (((tactile_side IS NULL) OR (tactile_side = ANY (ARRAY['left'::text, 'right'::text])))),
    CONSTRAINT way_snapshots_way_version_check CHECK ((way_version > 0))
);


--
-- Name: fitting_comparisons id; Type: DEFAULT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.fitting_comparisons ALTER COLUMN id SET DEFAULT nextval('experiment.fitting_comparisons_id_seq'::regclass);


--
-- Name: osm_connection_audit audit_id; Type: DEFAULT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_connection_audit ALTER COLUMN audit_id SET DEFAULT nextval('login.osm_connection_audit_audit_id_seq'::regclass);


--
-- Name: osm_service_account_audit audit_id; Type: DEFAULT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_service_account_audit ALTER COLUMN audit_id SET DEFAULT nextval('login.osm_service_account_audit_audit_id_seq'::regclass);


--
-- Name: user_auth_providers auth_id; Type: DEFAULT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_auth_providers ALTER COLUMN auth_id SET DEFAULT nextval('login.user_auth_providers_auth_id_seq'::regclass);


--
-- Name: user_consents consent_id; Type: DEFAULT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_consents ALTER COLUMN consent_id SET DEFAULT nextval('login.user_consents_consent_id_seq'::regclass);


--
-- Name: users user_id; Type: DEFAULT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.users ALTER COLUMN user_id SET DEFAULT nextval('login.users_user_id_seq'::regclass);


--
-- Name: audit_events event_id; Type: DEFAULT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.audit_events ALTER COLUMN event_id SET DEFAULT nextval('osmchange.audit_events_event_id_seq'::regclass);


--
-- Name: road_info_media id; Type: DEFAULT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_media ALTER COLUMN id SET DEFAULT nextval('roadinfo.road_info_media_id_seq'::regclass);


--
-- Name: road_info_note id; Type: DEFAULT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_note ALTER COLUMN id SET DEFAULT nextval('roadinfo.road_info_note_id_seq'::regclass);


--
-- Name: road_info_point id; Type: DEFAULT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_point ALTER COLUMN id SET DEFAULT nextval('roadinfo.road_info_point_id_seq'::regclass);


--
-- Name: road_info_tag id; Type: DEFAULT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_tag ALTER COLUMN id SET DEFAULT nextval('roadinfo.road_info_tag_id_seq'::regclass);


--
-- Name: gps_matched id; Type: DEFAULT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.gps_matched ALTER COLUMN id SET DEFAULT nextval('tactile.gps_matched_id_seq'::regclass);


--
-- Name: gps_raw id; Type: DEFAULT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.gps_raw ALTER COLUMN id SET DEFAULT nextval('tactile.gps_raw_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.tags ALTER COLUMN id SET DEFAULT nextval('tactile.tags_id_seq'::regclass);


--
-- Name: api_record_audit api_record_audit_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.api_record_audit
    ADD CONSTRAINT api_record_audit_pkey PRIMARY KEY (event_id);


--
-- Name: api_records api_records_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.api_records
    ADD CONSTRAINT api_records_pkey PRIMARY KEY (experiment_id);


--
-- Name: fitting_comparisons fitting_comparisons_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.fitting_comparisons
    ADD CONSTRAINT fitting_comparisons_pkey PRIMARY KEY (id);


--
-- Name: fitting_outlier_maps fitting_outlier_maps_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.fitting_outlier_maps
    ADD CONSTRAINT fitting_outlier_maps_pkey PRIMARY KEY (batch_id, source_session_digest);


--
-- Name: fitting_replay_runs fitting_replay_runs_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.fitting_replay_runs
    ADD CONSTRAINT fitting_replay_runs_pkey PRIMARY KEY (run_id);


--
-- Name: gps_replay_runs gps_replay_runs_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.gps_replay_runs
    ADD CONSTRAINT gps_replay_runs_pkey PRIMARY KEY (replay_id);


--
-- Name: production_fitting_batch_results production_fitting_batch_results_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.production_fitting_batch_results
    ADD CONSTRAINT production_fitting_batch_results_pkey PRIMARY KEY (batch_id, source_session_digest);


--
-- Name: production_fitting_batches production_fitting_batches_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.production_fitting_batches
    ADD CONSTRAINT production_fitting_batches_pkey PRIMARY KEY (batch_id);


--
-- Name: production_record_imports production_record_imports_development_session_id_key; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.production_record_imports
    ADD CONSTRAINT production_record_imports_development_session_id_key UNIQUE (development_session_id);


--
-- Name: production_record_imports production_record_imports_pkey; Type: CONSTRAINT; Schema: experiment; Owner: -
--

ALTER TABLE ONLY experiment.production_record_imports
    ADD CONSTRAINT production_record_imports_pkey PRIMARY KEY (import_id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (token);


--
-- Name: osm_connection_audit osm_connection_audit_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_connection_audit
    ADD CONSTRAINT osm_connection_audit_pkey PRIMARY KEY (audit_id);


--
-- Name: osm_connections osm_connections_osm_user_id_key; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_connections
    ADD CONSTRAINT osm_connections_osm_user_id_key UNIQUE (osm_user_id);


--
-- Name: osm_connections osm_connections_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_connections
    ADD CONSTRAINT osm_connections_pkey PRIMARY KEY (user_id);


--
-- Name: osm_oauth_states osm_oauth_states_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_oauth_states
    ADD CONSTRAINT osm_oauth_states_pkey PRIMARY KEY (state_hash);


--
-- Name: osm_service_account_audit osm_service_account_audit_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_service_account_audit
    ADD CONSTRAINT osm_service_account_audit_pkey PRIMARY KEY (audit_id);


--
-- Name: osm_service_account osm_service_account_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_service_account
    ADD CONSTRAINT osm_service_account_pkey PRIMARY KEY (singleton);


--
-- Name: osm_service_oauth_states osm_service_oauth_states_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_service_oauth_states
    ADD CONSTRAINT osm_service_oauth_states_pkey PRIMARY KEY (state_hash);


--
-- Name: user_auth_providers user_auth_providers_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_auth_providers
    ADD CONSTRAINT user_auth_providers_pkey PRIMARY KEY (auth_id);


--
-- Name: user_consents user_consents_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_consents
    ADD CONSTRAINT user_consents_pkey PRIMARY KEY (consent_id);


--
-- Name: user_consents user_consents_user_id_terms_version_privacy_version_key; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_consents
    ADD CONSTRAINT user_consents_user_id_terms_version_privacy_version_key UNIQUE (user_id, terms_version, privacy_version);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (event_id);


--
-- Name: change_plans change_plans_pkey; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.change_plans
    ADD CONSTRAINT change_plans_pkey PRIMARY KEY (plan_id);


--
-- Name: execution_attempts execution_attempts_pkey; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.execution_attempts
    ADD CONSTRAINT execution_attempts_pkey PRIMARY KEY (attempt_id);


--
-- Name: opt_out_rules opt_out_rules_pkey; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.opt_out_rules
    ADD CONSTRAINT opt_out_rules_pkey PRIMARY KEY (rule_id);


--
-- Name: record_links record_links_merge_changeset_id_key; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.record_links
    ADD CONSTRAINT record_links_merge_changeset_id_key UNIQUE (merge_changeset_id);


--
-- Name: record_links record_links_merge_plan_id_key; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.record_links
    ADD CONSTRAINT record_links_merge_plan_id_key UNIQUE (merge_plan_id);


--
-- Name: record_links record_links_pkey; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.record_links
    ADD CONSTRAINT record_links_pkey PRIMARY KEY (record_id);


--
-- Name: record_links record_links_revert_changeset_id_key; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.record_links
    ADD CONSTRAINT record_links_revert_changeset_id_key UNIQUE (revert_changeset_id);


--
-- Name: record_links record_links_revert_plan_id_key; Type: CONSTRAINT; Schema: osmchange; Owner: -
--

ALTER TABLE ONLY osmchange.record_links
    ADD CONSTRAINT record_links_revert_plan_id_key UNIQUE (revert_plan_id);


--
-- Name: road_info_media road_info_media_pkey; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_media
    ADD CONSTRAINT road_info_media_pkey PRIMARY KEY (id);


--
-- Name: road_info_note road_info_note_pkey; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_note
    ADD CONSTRAINT road_info_note_pkey PRIMARY KEY (id);


--
-- Name: road_info_point road_info_point_pkey; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_point
    ADD CONSTRAINT road_info_point_pkey PRIMARY KEY (id);


--
-- Name: road_info_point_tag road_info_point_tag_pkey; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_point_tag
    ADD CONSTRAINT road_info_point_tag_pkey PRIMARY KEY (point_id, tag_id);


--
-- Name: road_info_tag road_info_tag_code_key; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_tag
    ADD CONSTRAINT road_info_tag_code_key UNIQUE (code);


--
-- Name: road_info_tag road_info_tag_pkey; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_tag
    ADD CONSTRAINT road_info_tag_pkey PRIMARY KEY (id);


--
-- Name: submission_keys submission_keys_pkey; Type: CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.submission_keys
    ADD CONSTRAINT submission_keys_pkey PRIMARY KEY (user_id, submission_key);


--
-- Name: gps_matched gps_matched_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.gps_matched
    ADD CONSTRAINT gps_matched_pkey PRIMARY KEY (id);


--
-- Name: gps_raw gps_raw_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.gps_raw
    ADD CONSTRAINT gps_raw_pkey PRIMARY KEY (id);


--
-- Name: session_path_edges session_path_edges_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_path_edges
    ADD CONSTRAINT session_path_edges_pkey PRIMARY KEY (session_id, seq);


--
-- Name: session_paths session_paths_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_paths
    ADD CONSTRAINT session_paths_pkey PRIMARY KEY (session_id);


--
-- Name: session_tags session_tags_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_tags
    ADD CONSTRAINT session_tags_pkey PRIMARY KEY (session_id, tag_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (session_id);


--
-- Name: tags tags_code_key; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.tags
    ADD CONSTRAINT tags_code_key UNIQUE (code);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: way_snapshots way_snapshots_pkey; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.way_snapshots
    ADD CONSTRAINT way_snapshots_pkey PRIMARY KEY (snapshot_id);


--
-- Name: way_snapshots way_snapshots_record_id_segment_order_key; Type: CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.way_snapshots
    ADD CONSTRAINT way_snapshots_record_id_segment_order_key UNIQUE (record_id, segment_order);


--
-- Name: fitting_comparisons_created_idx; Type: INDEX; Schema: experiment; Owner: -
--

CREATE INDEX fitting_comparisons_created_idx ON experiment.fitting_comparisons USING btree (created_at DESC);


--
-- Name: fitting_comparisons_session_idx; Type: INDEX; Schema: experiment; Owner: -
--

CREATE INDEX fitting_comparisons_session_idx ON experiment.fitting_comparisons USING btree (experiment_session_uuid, created_at);


--
-- Name: ix_user_sessions_user_id; Type: INDEX; Schema: login; Owner: -
--

CREATE INDEX ix_user_sessions_user_id ON login.user_sessions USING btree (user_id);


--
-- Name: uix_uap_email_only; Type: INDEX; Schema: login; Owner: -
--

CREATE UNIQUE INDEX uix_uap_email_only ON login.user_auth_providers USING btree (email) WHERE ((provider)::text = 'email'::text);


--
-- Name: uix_uap_google_sub; Type: INDEX; Schema: login; Owner: -
--

CREATE UNIQUE INDEX uix_uap_google_sub ON login.user_auth_providers USING btree (provider_user_id) WHERE ((provider)::text = 'google'::text);


--
-- Name: osm_audit_plan_idx; Type: INDEX; Schema: osmchange; Owner: -
--

CREATE INDEX osm_audit_plan_idx ON osmchange.audit_events USING btree (plan_id, event_id);


--
-- Name: osm_change_plans_created_idx; Type: INDEX; Schema: osmchange; Owner: -
--

CREATE INDEX osm_change_plans_created_idx ON osmchange.change_plans USING btree (created_at DESC);


--
-- Name: osm_record_links_user_idx; Type: INDEX; Schema: osmchange; Owner: -
--

CREATE INDEX osm_record_links_user_idx ON osmchange.record_links USING btree (created_by, created_at DESC);


--
-- Name: road_info_media_note_idx; Type: INDEX; Schema: roadinfo; Owner: -
--

CREATE INDEX road_info_media_note_idx ON roadinfo.road_info_media USING btree (note_id);


--
-- Name: road_info_note_point_idx; Type: INDEX; Schema: roadinfo; Owner: -
--

CREATE INDEX road_info_note_point_idx ON roadinfo.road_info_note USING btree (point_id, created_at DESC);


--
-- Name: road_info_point_geom_idx; Type: INDEX; Schema: roadinfo; Owner: -
--

CREATE INDEX road_info_point_geom_idx ON roadinfo.road_info_point USING gist (geom);


--
-- Name: road_info_point_status_idx; Type: INDEX; Schema: roadinfo; Owner: -
--

CREATE INDEX road_info_point_status_idx ON roadinfo.road_info_point USING btree (status);


--
-- Name: road_info_point_tag_tag_idx; Type: INDEX; Schema: roadinfo; Owner: -
--

CREATE INDEX road_info_point_tag_tag_idx ON roadinfo.road_info_point_tag USING btree (tag_id);


--
-- Name: road_info_tag_sort_idx; Type: INDEX; Schema: roadinfo; Owner: -
--

CREATE INDEX road_info_tag_sort_idx ON roadinfo.road_info_tag USING btree (sort_order);


--
-- Name: idx_tactile_sessions_user_id; Type: INDEX; Schema: tactile; Owner: -
--

CREATE INDEX idx_tactile_sessions_user_id ON tactile.sessions USING btree (user_id);


--
-- Name: fitting_comparisons fitting_comparisons_append_only; Type: TRIGGER; Schema: experiment; Owner: -
--

CREATE TRIGGER fitting_comparisons_append_only BEFORE DELETE OR UPDATE ON experiment.fitting_comparisons FOR EACH ROW EXECUTE FUNCTION experiment.prevent_fitting_history_mutation();


--
-- Name: osm_connection_audit osm_connection_audit_append_only; Type: TRIGGER; Schema: login; Owner: -
--

CREATE TRIGGER osm_connection_audit_append_only BEFORE DELETE OR UPDATE ON login.osm_connection_audit FOR EACH ROW EXECUTE FUNCTION login.prevent_osm_audit_mutation();


--
-- Name: osm_service_account_audit osm_service_account_audit_append_only; Type: TRIGGER; Schema: login; Owner: -
--

CREATE TRIGGER osm_service_account_audit_append_only BEFORE DELETE OR UPDATE ON login.osm_service_account_audit FOR EACH ROW EXECUTE FUNCTION login.prevent_osm_service_audit_mutation();


--
-- Name: user_consents user_consents_append_only; Type: TRIGGER; Schema: login; Owner: -
--

CREATE TRIGGER user_consents_append_only BEFORE DELETE OR UPDATE ON login.user_consents FOR EACH ROW EXECUTE FUNCTION login.prevent_consent_mutation();


--
-- Name: audit_events osm_audit_events_append_only; Type: TRIGGER; Schema: osmchange; Owner: -
--

CREATE TRIGGER osm_audit_events_append_only BEFORE DELETE OR UPDATE ON osmchange.audit_events FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation();


--
-- Name: change_plans osm_change_plans_append_only; Type: TRIGGER; Schema: osmchange; Owner: -
--

CREATE TRIGGER osm_change_plans_append_only BEFORE DELETE OR UPDATE ON osmchange.change_plans FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation();


--
-- Name: execution_attempts osm_execution_attempts_append_only; Type: TRIGGER; Schema: osmchange; Owner: -
--

CREATE TRIGGER osm_execution_attempts_append_only BEFORE DELETE OR UPDATE ON osmchange.execution_attempts FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation();


--
-- Name: record_links osm_record_links_no_delete; Type: TRIGGER; Schema: osmchange; Owner: -
--

CREATE TRIGGER osm_record_links_no_delete BEFORE DELETE ON osmchange.record_links FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_record_link_delete();


--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE CASCADE;


--
-- Name: osm_connection_audit osm_connection_audit_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_connection_audit
    ADD CONSTRAINT osm_connection_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE RESTRICT;


--
-- Name: osm_connections osm_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_connections
    ADD CONSTRAINT osm_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE RESTRICT;


--
-- Name: osm_oauth_states osm_oauth_states_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.osm_oauth_states
    ADD CONSTRAINT osm_oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE CASCADE;


--
-- Name: user_auth_providers user_auth_providers_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_auth_providers
    ADD CONSTRAINT user_auth_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE CASCADE;


--
-- Name: user_consents user_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_consents
    ADD CONSTRAINT user_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE RESTRICT;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: login; Owner: -
--

ALTER TABLE ONLY login.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE CASCADE;


--
-- Name: road_info_media road_info_media_created_by_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_media
    ADD CONSTRAINT road_info_media_created_by_fkey FOREIGN KEY (created_by) REFERENCES login.users(user_id);


--
-- Name: road_info_media road_info_media_note_id_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_media
    ADD CONSTRAINT road_info_media_note_id_fkey FOREIGN KEY (note_id) REFERENCES roadinfo.road_info_note(id) ON DELETE CASCADE;


--
-- Name: road_info_note road_info_note_created_by_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_note
    ADD CONSTRAINT road_info_note_created_by_fkey FOREIGN KEY (created_by) REFERENCES login.users(user_id);


--
-- Name: road_info_note road_info_note_point_id_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_note
    ADD CONSTRAINT road_info_note_point_id_fkey FOREIGN KEY (point_id) REFERENCES roadinfo.road_info_point(id) ON DELETE CASCADE;


--
-- Name: road_info_point road_info_point_created_by_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_point
    ADD CONSTRAINT road_info_point_created_by_fkey FOREIGN KEY (created_by) REFERENCES login.users(user_id);


--
-- Name: road_info_point_tag road_info_point_tag_point_id_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_point_tag
    ADD CONSTRAINT road_info_point_tag_point_id_fkey FOREIGN KEY (point_id) REFERENCES roadinfo.road_info_point(id) ON DELETE CASCADE;


--
-- Name: road_info_point_tag road_info_point_tag_tag_id_fkey; Type: FK CONSTRAINT; Schema: roadinfo; Owner: -
--

ALTER TABLE ONLY roadinfo.road_info_point_tag
    ADD CONSTRAINT road_info_point_tag_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES roadinfo.road_info_tag(id) ON DELETE CASCADE;


--
-- Name: session_tags fk_session_tags_session; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_tags
    ADD CONSTRAINT fk_session_tags_session FOREIGN KEY (session_id) REFERENCES tactile.sessions(session_id) ON DELETE CASCADE;


--
-- Name: session_tags fk_session_tags_tag; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_tags
    ADD CONSTRAINT fk_session_tags_tag FOREIGN KEY (tag_id) REFERENCES tactile.tags(id) ON DELETE RESTRICT;


--
-- Name: gps_matched gps_matched_session_id_fkey; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.gps_matched
    ADD CONSTRAINT gps_matched_session_id_fkey FOREIGN KEY (session_id) REFERENCES tactile.sessions(session_id);


--
-- Name: gps_raw gps_raw_session_id_fkey; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.gps_raw
    ADD CONSTRAINT gps_raw_session_id_fkey FOREIGN KEY (session_id) REFERENCES tactile.sessions(session_id);


--
-- Name: session_path_edges session_path_edges_session_id_fkey; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_path_edges
    ADD CONSTRAINT session_path_edges_session_id_fkey FOREIGN KEY (session_id) REFERENCES tactile.sessions(session_id);


--
-- Name: session_paths session_paths_session_id_fkey; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.session_paths
    ADD CONSTRAINT session_paths_session_id_fkey FOREIGN KEY (session_id) REFERENCES tactile.sessions(session_id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: tactile; Owner: -
--

ALTER TABLE ONLY tactile.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES login.users(user_id);


--
-- PostgreSQL database dump complete
--

\unrestrict sXjP7hk4mRNdoyoWiacnACvY1DtJ7OnmNqZ3N4roidb5f3sMVbXu7gOtETz5QdL
