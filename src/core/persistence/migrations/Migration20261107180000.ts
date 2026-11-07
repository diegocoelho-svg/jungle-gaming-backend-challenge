import { Migration } from "@mikro-orm/migrations";

export class Migration20261107180000 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null check (player_id <> ''),
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_key unique (player_id, currency),
        constraint wallets_id_currency_key unique (id, currency)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null check (provider_id <> ''),
        external_transaction_id text not null check (external_transaction_id <> ''),
        idempotency_key text not null check (idempotency_key <> ''),
        payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid not null references wallets (id) deferrable initially deferred,
        player_id text not null check (player_id <> ''),
        round_id text not null check (round_id <> ''),
        game_id text not null check (game_id <> ''),
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) not null check (amount >= 0),
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text check (reference_external_transaction_id <> ''),
        reference_transaction_id uuid references wager_transactions (id) deferrable initially deferred,
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        result_balance numeric(20, 2) check (result_balance >= 0),
        result_balance_currency text check (result_balance_currency ~ '^[A-Z]{3}$'),
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_idempotency_key unique (provider_id, idempotency_key),
        constraint wager_transactions_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_id_wallet_key unique (id, wallet_id),
        constraint wager_transactions_id_external_key unique (id, provider_id, external_transaction_id),
        constraint wager_transactions_reference_matches_declared
          foreign key (reference_transaction_id, provider_id, reference_external_transaction_id)
          references wager_transactions (id, provider_id, external_transaction_id)
          deferrable initially deferred,
        constraint wager_transactions_processed_reversal_is_resolved
          check (kind not in ('REFUND', 'ROLLBACK') or status <> 'PROCESSED' or reference_transaction_id is not null),
        constraint wager_transactions_amount_positive check (kind = 'LOSS' or amount > 0),
        constraint wager_transactions_reversal_has_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_resolved_reference_is_declared
          check (reference_transaction_id is null or reference_external_transaction_id is not null),
        constraint wager_transactions_failure_code_on_failure
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_result_balance_pair
          check ((result_balance is null) = (result_balance_currency is null)),
        constraint wager_transactions_settled_has_result_balance
          check (status not in ('PROCESSED', 'REJECTED') or result_balance is not null),
        constraint wager_transactions_processed_has_timestamp
          check (status <> 'PROCESSED' or processed_at is not null),
        constraint wager_transactions_pending_reference_is_scheduled
          check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null)
      )
    `);

    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
    `);

    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null check (amount > 0),
        currency text not null,
        balance_before numeric(20, 2) not null check (balance_before >= 0),
        balance_after numeric(20, 2) not null check (balance_after >= 0),
        wallet_version integer not null check (wallet_version >= 1),
        created_at timestamptz not null,
        constraint wallet_ledger_entries_wallet_currency_fkey
          foreign key (wallet_id, currency) references wallets (id, currency) deferrable initially deferred,
        constraint wallet_ledger_entries_transaction_wallet_fkey
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id) deferrable initially deferred,
        constraint wallet_ledger_entries_one_per_transaction unique (wallet_id, transaction_id),
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_balanced check (
          balance_after = case direction
            when 'CREDIT' then balance_before + amount
            else balance_before - amount
          end
        )
      )
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null check (consumer_name <> ''),
        message_id text not null check (message_id <> ''),
        payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz
      )
    `);

    this.addSql(`
      create index outbox_messages_pending
        on outbox_messages (next_attempt_at nulls first, occurred_at)
        where published_at is null
    `);

    this.addSql(`
      create function check_wallet_version() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'wallet % must start at version 1', new.id;
          end if;
          return new;
        end if;

        if (new.id, new.player_id, new.currency, new.created_at)
          is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet % has immutable fields', old.id;
        end if;

        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % must increment its version by one when the balance changes', old.id;
        end if;

        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % cannot change its version without a balance change', old.id;
        end if;

        return new;
      end
      $$
    `);

    this.addSql(`
      create trigger wallets_version_rules
        before insert or update on wallets
        for each row execute function check_wallet_version()
    `);

    this.addSql(`
      create function reject_ledger_change() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end
      $$
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function reject_ledger_change()
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function reject_ledger_change()
    `);

    this.addSql(`
      create function guard_wager_transaction_change() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions cannot be deleted';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status;
        end if;

        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
          is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % has immutable fields', old.id;
        end if;

        return new;
      end
      $$
    `);

    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function guard_wager_transaction_change()
    `);

    this.addSql(`
      create function check_ledger_entry_chain() returns trigger language plpgsql as $$
      declare
        previous_balance numeric(20, 2);
        first_movement boolean;
      begin
        select balance_after into previous_balance
          from wallet_ledger_entries
         where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;

        if found then
          if new.balance_before <> previous_balance then
            raise exception 'ledger entry % breaks the balance chain of wallet %', new.id, new.wallet_id;
          end if;
          return new;
        end if;

        select not exists (select 1 from wallet_ledger_entries where wallet_id = new.wallet_id) into first_movement;

        if new.balance_before <> 0 or not (new.wallet_version = 1 or (new.wallet_version = 2 and first_movement)) then
          raise exception 'ledger entry % breaks the balance chain of wallet %', new.id, new.wallet_id;
        end if;

        return new;
      end
      $$
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_chain
        before insert on wallet_ledger_entries
        for each row execute function check_ledger_entry_chain()
    `);

    this.addSql(`
      create function check_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet uuid := coalesce(to_jsonb(new) ->> 'wallet_id', to_jsonb(new) ->> 'id')::uuid;
        current_balance numeric(20, 2);
        current_version integer;
        latest_balance numeric(20, 2);
        latest_version integer;
      begin
        select balance, version into current_balance, current_version
          from wallets
         where id = target_wallet;

        select balance_after, wallet_version into latest_balance, latest_version
          from wallet_ledger_entries
         where wallet_id = target_wallet
         order by wallet_version desc
         limit 1;

        if latest_version is null then
          if current_balance <> 0 or current_version <> 1 then
            raise exception 'wallet % changed balance without a ledger entry', target_wallet;
          end if;
        elsif latest_version <> current_version or latest_balance <> current_balance then
          raise exception 'wallet % does not match its latest ledger entry', target_wallet;
        end if;

        return null;
      end
      $$
    `);

    this.addSql(`
      create constraint trigger wallets_match_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger()
    `);

    this.addSql(`
      create function check_ledger_entry_transaction() returns trigger language plpgsql as $$
      declare
        transaction_row wager_transactions%rowtype;
        reference_kind text;
        expected_direction text;
      begin
        select * into transaction_row from wager_transactions where id = new.transaction_id;

        if transaction_row.status <> 'PROCESSED' then
          raise exception 'ledger entry % belongs to a % transaction', new.id, transaction_row.status;
        end if;

        if transaction_row.amount <> new.amount or transaction_row.currency <> new.currency then
          raise exception 'ledger entry % does not match the amount of transaction %', new.id, new.transaction_id;
        end if;

        if transaction_row.kind = 'ROLLBACK' then
          select kind into reference_kind from wager_transactions where id = transaction_row.reference_transaction_id;
        end if;

        expected_direction := case
          when transaction_row.kind = 'BET' then 'DEBIT'
          when transaction_row.kind in ('WIN', 'REFUND', 'OPENING') then 'CREDIT'
          when transaction_row.kind = 'ROLLBACK' and reference_kind = 'BET' then 'CREDIT'
          when transaction_row.kind = 'ROLLBACK' and reference_kind in ('WIN', 'REFUND') then 'DEBIT'
        end;

        if expected_direction is null or expected_direction <> new.direction then
          raise exception 'ledger entry % has the wrong direction for a % transaction', new.id, transaction_row.kind;
        end if;

        return null;
      end
      $$
    `);

    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_transaction
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function check_ledger_entry_transaction()
    `);

    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger()
    `);
  }

  override down(): void {
    this.addSql("drop trigger wallet_ledger_entries_match_wallet on wallet_ledger_entries");
    this.addSql("drop trigger wallet_ledger_entries_match_transaction on wallet_ledger_entries");
    this.addSql("drop trigger wallets_match_ledger on wallets");
    this.addSql("drop table outbox_messages");
    this.addSql("drop table inbox_messages");
    this.addSql("drop table wallet_ledger_entries");
    this.addSql("drop table wager_transactions");
    this.addSql("drop table wallets");
    this.addSql("drop function check_wallet_matches_ledger");
    this.addSql("drop function check_ledger_entry_transaction");
    this.addSql("drop function check_ledger_entry_chain");
    this.addSql("drop function guard_wager_transaction_change");
    this.addSql("drop function reject_ledger_change");
    this.addSql("drop function check_wallet_version");
  }
}
