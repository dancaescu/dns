# Database Migrations

This directory contains SQL migration files for updating the MyDNS database schema.

## Migration Naming Convention

Migrations follow this naming pattern:
- **Forward migration**: `add_comment_tags_to_cloudflare_records.sql`
- **Rollback migration**: `rollback_add_comment_tags_to_cloudflare_records.sql`

## Available Migrations

### 2025-11-20: Add Load Balancer Pools and Origins Tables

**Purpose**: Creates dedicated tables for managing load balancer pools and their origins/endpoints with full CRUD capabilities including health monitoring, weight distribution, and steering policies.

**Tables Created**:
- `cloudflare_lb_pools`: Pool configuration with monitoring, steering policy, and notification settings
- `cloudflare_lb_pool_origins`: Individual endpoints within pools with weight, port, and header configuration

**Forward Migration**:
```bash
mysql -u <user> -p <database> < migrations/add_lb_pools_and_origins.sql
```

**Rollback**:
```bash
mysql -u <user> -p <database> < migrations/rollback_add_lb_pools_and_origins.sql
```

### 2025-11-20: Add Comment and Tags to Cloudflare Records

**Purpose**: Adds support for Cloudflare's `comment` and `tags` fields to the `cloudflare_records` table.

**Forward Migration**:
```bash
mysql -u <user> -p <database> < migrations/add_comment_tags_to_cloudflare_records.sql
```

**Rollback**:
```bash
mysql -u <user> -p <database> < migrations/rollback_add_comment_tags_to_cloudflare_records.sql
```

## Applying Migrations

### For MySQL/MariaDB:

```bash
# Apply a migration
mysql -u mydns -p mydns < schema/migrations/add_comment_tags_to_cloudflare_records.sql

# Rollback a migration
mysql -u mydns -p mydns < schema/migrations/rollback_add_comment_tags_to_cloudflare_records.sql
```

### For PostgreSQL:

```bash
# Apply a migration
psql -U mydns -d mydns -f schema/migrations/add_comment_tags_to_cloudflare_records.sql

# Rollback a migration
psql -U mydns -d mydns -f schema/migrations/rollback_add_comment_tags_to_cloudflare_records.sql
```

## Best Practices

1. **Always backup your database** before applying migrations
2. **Test migrations** in a development environment first
3. **Keep migrations atomic** - each migration should be a single logical change
4. **Document migrations** - add comments explaining what and why
5. **Create rollback migrations** for all schema changes

## Verification

After applying a migration, verify the changes:

```bash
# Check table structure
mysql -u mydns -p mydns -e "DESCRIBE cloudflare_records;"

# Or for PostgreSQL
psql -U mydns -d mydns -c "\d cloudflare_records"
```
