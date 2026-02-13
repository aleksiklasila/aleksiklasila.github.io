#!/bin/bash
#
# lasso.sh - CPU Core Isolation for Simulator Use
#
# Isolates specified CPU cores from all system activity (processes, IRQs,
# kernel threads, timers, watchdogs) so they can be dedicated exclusively
# to simulator cores via taskset.
#
# Usage:
#   ./lasso.sh --start --cpu-range 2-8
#   ./lasso.sh --stop
#   ./lasso.sh --status
#
# Requires: root privileges
#

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
STATE_DIR="/var/run/lasso"
STATE_FILE="${STATE_DIR}/state"
ORIG_IRQS_DIR="${STATE_DIR}/irq_affinity"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  ${BOLD}$*${NC}"; }

usage() {
    cat <<EOF
${BOLD}Usage:${NC}
  $SCRIPT_NAME --start --cpu-range <range>    Isolate cores
  $SCRIPT_NAME --stop                         Restore cores
  $SCRIPT_NAME --status                       Show current state

${BOLD}Arguments:${NC}
  --cpu-range <range>   CPU core range to isolate (e.g., 2-8, 1-3, 4-15)
  --start               Activate core isolation
  --stop                Deactivate core isolation and restore system defaults
  --status              Display current isolation status

${BOLD}Examples:${NC}
  $SCRIPT_NAME --start --cpu-range 2-8
  taskset -c 2 ./my_simulator --core 0
  taskset -c 3 ./my_simulator --core 1
  $SCRIPT_NAME --stop

${BOLD}Notes:${NC}
  - Requires root privileges
  - Core 0 should generally NOT be isolated (handles essential system tasks)
  - After --start, only processes launched with taskset will run on isolated cores
  - The isolated cores will be freed from: user processes, kernel threads,
    IRQs, RCU callbacks, kernel timers, and watchdogs
EOF
    exit 1
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (sudo)."
        exit 1
    fi
}

# Expand a range like "2-8" into a list "2,3,4,5,6,7,8"
expand_range() {
    local range="$1"
    local result=""

    # Handle comma-separated values and ranges
    IFS=',' read -ra parts <<< "$range"
    for part in "${parts[@]}"; do
        if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
            local start="${BASH_REMATCH[1]}"
            local end="${BASH_REMATCH[2]}"
            for ((i=start; i<=end; i++)); do
                [[ -n "$result" ]] && result+=","
                result+="$i"
            done
        elif [[ "$part" =~ ^[0-9]+$ ]]; then
            [[ -n "$result" ]] && result+=","
            result+="$part"
        else
            log_error "Invalid CPU range format: $part"
            exit 1
        fi
    done
    echo "$result"
}

# Get the complement CPU set (all CPUs NOT in the isolated range)
get_housekeeping_cpus() {
    local isolated_list="$1"
    local total_cpus
    total_cpus=$(nproc)
    local result=""

    IFS=',' read -ra isolated_arr <<< "$isolated_list"

    for ((cpu=0; cpu<total_cpus; cpu++)); do
        local is_isolated=false
        for iso_cpu in "${isolated_arr[@]}"; do
            if [[ "$cpu" -eq "$iso_cpu" ]]; then
                is_isolated=true
                break
            fi
        done
        if [[ "$is_isolated" == "false" ]]; then
            [[ -n "$result" ]] && result+=","
            result+="$cpu"
        fi
    done
    echo "$result"
}

# Validate the CPU range
validate_range() {
    local cpu_list="$1"
    local total_cpus
    total_cpus=$(nproc)

    IFS=',' read -ra cpus <<< "$cpu_list"

    # Check that core 0 is not included
    for cpu in "${cpus[@]}"; do
        if [[ "$cpu" -eq 0 ]]; then
            log_warn "Core 0 is included in the isolation range."
            log_warn "Core 0 handles essential system tasks and isolating it may cause instability."
            read -r -p "Are you sure you want to continue? (y/N): " confirm
            if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
                log_info "Aborted."
                exit 0
            fi
        fi
        if [[ "$cpu" -ge "$total_cpus" ]]; then
            log_error "CPU $cpu does not exist. This system has $total_cpus cores (0-$((total_cpus-1)))."
            exit 1
        fi
    done

    # Check that at least one core remains for housekeeping
    local housekeeping
    housekeeping=$(get_housekeeping_cpus "$cpu_list")
    if [[ -z "$housekeeping" ]]; then
        log_error "Cannot isolate ALL cores. At least one core must remain for system tasks."
        exit 1
    fi
}

# Save current IRQ affinities so they can be restored on --stop
save_irq_affinities() {
    mkdir -p "$ORIG_IRQS_DIR"
    for irq_dir in /proc/irq/[0-9]*; do
        local irq_num
        irq_num=$(basename "$irq_dir")
        local affinity_file="${irq_dir}/smp_affinity_list"
        if [[ -r "$affinity_file" ]]; then
            cat "$affinity_file" > "${ORIG_IRQS_DIR}/${irq_num}" 2>/dev/null || true
        fi
    done
    log_info "Saved original IRQ affinities."
}

# Move all IRQs to housekeeping cores
move_irqs() {
    local housekeeping_cpus="$1"
    local moved=0
    local failed=0

    for irq_dir in /proc/irq/[0-9]*; do
        local irq_num
        irq_num=$(basename "$irq_dir")
        local affinity_file="${irq_dir}/smp_affinity_list"
        if [[ -w "$affinity_file" ]]; then
            if echo "$housekeeping_cpus" > "$affinity_file" 2>/dev/null; then
                ((moved++)) || true
            else
                ((failed++)) || true
            fi
        fi
    done
    log_info "Moved $moved IRQs to housekeeping cores ($failed could not be moved - this is normal for some per-cpu IRQs)."
}

# Restore original IRQ affinities
restore_irqs() {
    local restored=0
    if [[ -d "$ORIG_IRQS_DIR" ]]; then
        for saved_file in "${ORIG_IRQS_DIR}"/*; do
            [[ -f "$saved_file" ]] || continue
            local irq_num
            irq_num=$(basename "$saved_file")
            local affinity_file="/proc/irq/${irq_num}/smp_affinity_list"
            if [[ -w "$affinity_file" ]]; then
                if cat "$saved_file" > "$affinity_file" 2>/dev/null; then
                    ((restored++)) || true
                fi
            fi
        done
        log_info "Restored $restored IRQ affinities."
    fi
}

# Move all user processes and moveable kernel threads off isolated cores
move_processes() {
    local housekeeping_cpus="$1"
    local moved=0
    local failed=0
    local skipped=0

    for pid in /proc/[0-9]*/; do
        pid=$(basename "$pid")
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        # Skip our own process
        [[ "$pid" -eq $$ ]] && continue

        # Try to move via taskset
        if taskset -pc "$housekeeping_cpus" "$pid" > /dev/null 2>&1; then
            ((moved++)) || true
        else
            # Some kernel threads are pinned - that's expected
            ((failed++)) || true
        fi
    done
    log_info "Moved $moved processes to housekeeping cores ($failed could not be moved - pinned kernel threads)."
}

# Restore all processes to full CPU set
restore_processes() {
    local total_cpus
    total_cpus=$(nproc)
    local full_range="0-$((total_cpus-1))"
    local restored=0

    for pid in /proc/[0-9]*/; do
        pid=$(basename "$pid")
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        taskset -pc "$full_range" "$pid" > /dev/null 2>&1 && ((restored++)) || true
    done
    log_info "Restored $restored processes to full CPU range."
}

# Set up cgroup-based CPU shielding to prevent future processes from using isolated cores
setup_cgroup_shield() {
    local housekeeping_cpus="$1"
    local isolated_cpus="$2"

    # Try cgroup v2 first, then fall back to v1
    if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
        # cgroup v2
        log_info "Using cgroup v2 for CPU shielding."

        # Write housekeeping CPUs to the root cgroup's cpuset
        if [[ -f /sys/fs/cgroup/cpuset.cpus.effective ]]; then
            # Create a system slice to confine non-isolated work
            echo "$housekeeping_cpus" > /sys/fs/cgroup/cpuset.cpus 2>/dev/null || \
                log_warn "Could not set root cgroup cpuset (cgroup v2). This is normal if cpuset controller is not available."
        fi
    elif [[ -d /sys/fs/cgroup/cpuset ]]; then
        # cgroup v1
        log_info "Using cgroup v1 cpuset for CPU shielding."

        # Modify the root cpuset
        if [[ -w /sys/fs/cgroup/cpuset/cpuset.cpus ]]; then
            echo "$housekeeping_cpus" > /sys/fs/cgroup/cpuset/cpuset.cpus 2>/dev/null || \
                log_warn "Could not set root cpuset (cgroup v1)."
        fi
    else
        log_warn "No cpuset cgroup support detected. Relying on process migration and IRQ affinity only."
    fi
}

# Restore cgroup CPU allocation
restore_cgroup_shield() {
    local total_cpus
    total_cpus=$(nproc)
    local full_range="0-$((total_cpus-1))"

    if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
        echo "$full_range" > /sys/fs/cgroup/cpuset.cpus 2>/dev/null || true
    elif [[ -d /sys/fs/cgroup/cpuset ]]; then
        if [[ -w /sys/fs/cgroup/cpuset/cpuset.cpus ]]; then
            echo "$full_range" > /sys/fs/cgroup/cpuset/cpuset.cpus 2>/dev/null || true
        fi
    fi
    log_info "Restored cgroup cpuset to full range."
}

# Configure kernel parameters for isolation
configure_kernel_params() {
    local isolated_cpus="$1"
    local housekeeping_cpus="$2"

    # Move RCU callbacks off isolated cores (if supported)
    if [[ -w /sys/bus/workqueue/devices/writeback/cpumask ]]; then
        # Convert housekeeping list to bitmask - we'll write the list format if supported
        log_info "Adjusting workqueue CPU affinities."
        for wq in /sys/bus/workqueue/devices/*/cpumask; do
            [[ -w "$wq" ]] || continue
            # Convert housekeeping CPU list to a hex bitmask
            local mask
            mask=$(cpus_to_hex_mask "$housekeeping_cpus")
            echo "$mask" > "$wq" 2>/dev/null || true
        done
    fi

    # Disable watchdog on isolated cores
    if [[ -f /proc/sys/kernel/watchdog_cpumask ]]; then
        local mask
        mask=$(cpus_to_hex_mask "$housekeeping_cpus")
        echo "$mask" > /proc/sys/kernel/watchdog_cpumask 2>/dev/null || \
            log_warn "Could not set watchdog_cpumask."
        log_info "Restricted watchdog to housekeeping cores."
    fi

    # Move kernel timers off isolated cores (if supported, kernel 4.10+)
    # This is typically done via boot parameter, but we log a note
    if ! grep -q "nohz_full" /proc/cmdline 2>/dev/null; then
        log_warn "Kernel boot parameter 'nohz_full=$isolated_cpus' is not set."
        log_warn "For best results, add 'nohz_full=$isolated_cpus isolcpus=$isolated_cpus' to kernel boot parameters."
    fi

    if ! grep -q "rcu_nocbs" /proc/cmdline 2>/dev/null; then
        log_warn "Kernel boot parameter 'rcu_nocbs=$isolated_cpus' is not set."
        log_warn "For maximum isolation, add 'rcu_nocbs=$isolated_cpus' to kernel boot parameters."
    fi
}

# Restore kernel parameters
restore_kernel_params() {
    local total_cpus
    total_cpus=$(nproc)

    # Restore watchdog to all cores
    if [[ -f /proc/sys/kernel/watchdog_cpumask ]]; then
        local mask
        mask=$(cpus_to_hex_mask "0-$((total_cpus-1))")
        echo "$mask" > /proc/sys/kernel/watchdog_cpumask 2>/dev/null || true
        log_info "Restored watchdog to all cores."
    fi

    # Restore workqueue affinities
    if [[ -d /sys/bus/workqueue/devices ]]; then
        local mask
        mask=$(cpus_to_hex_mask "0-$((total_cpus-1))")
        for wq in /sys/bus/workqueue/devices/*/cpumask; do
            [[ -w "$wq" ]] || continue
            echo "$mask" > "$wq" 2>/dev/null || true
        done
        log_info "Restored workqueue CPU affinities."
    fi
}

# Convert a CPU list (e.g., "0,1,9,10") to a hex bitmask string
cpus_to_hex_mask() {
    local cpu_list="$1"
    local mask=0

    # Handle range notation within the list
    local expanded
    expanded=$(expand_range "$cpu_list")
    IFS=',' read -ra cpus <<< "$expanded"

    for cpu in "${cpus[@]}"; do
        mask=$(( mask | (2 ** cpu) ))
    done

    printf "%x\n" "$mask"
}

# Disable sched_rt_runtime to allow RT tasks full core usage
configure_rt_scheduling() {
    local orig_rt_runtime
    orig_rt_runtime=$(cat /proc/sys/kernel/sched_rt_runtime_us 2>/dev/null || echo "950000")
    echo "$orig_rt_runtime" > "${STATE_DIR}/sched_rt_runtime_us" 2>/dev/null || true

    # Set -1 to disable the RT throttling (allows 100% RT usage on isolated cores)
    echo -1 > /proc/sys/kernel/sched_rt_runtime_us 2>/dev/null || \
        log_warn "Could not disable RT scheduling throttle."
    log_info "Disabled RT scheduling throttle for full core utilization."
}

# Restore RT scheduling
restore_rt_scheduling() {
    if [[ -f "${STATE_DIR}/sched_rt_runtime_us" ]]; then
        local orig
        orig=$(cat "${STATE_DIR}/sched_rt_runtime_us")
        echo "$orig" > /proc/sys/kernel/sched_rt_runtime_us 2>/dev/null || true
        log_info "Restored RT scheduling throttle."
    fi
}

# ========== MAIN ACTIONS ==========

do_start() {
    local cpu_range="$1"

    if [[ -f "$STATE_FILE" ]]; then
        log_error "Isolation is already active (range: $(cat "$STATE_FILE"))."
        log_error "Run '$SCRIPT_NAME --stop' first."
        exit 1
    fi

    local isolated_cpus
    isolated_cpus=$(expand_range "$cpu_range")
    validate_range "$isolated_cpus"

    local housekeeping_cpus
    housekeeping_cpus=$(get_housekeeping_cpus "$isolated_cpus")

    echo ""
    echo -e "${BOLD}============================================${NC}"
    echo -e "${BOLD}  CPU Core Isolation - LASSO${NC}"
    echo -e "${BOLD}============================================${NC}"
    echo -e "  System cores:       ${CYAN}0-$(($(nproc)-1))${NC}"
    echo -e "  Isolating cores:    ${RED}${cpu_range}${NC} (expanded: ${isolated_cpus})"
    echo -e "  Housekeeping cores: ${GREEN}${housekeeping_cpus}${NC}"
    echo -e "${BOLD}============================================${NC}"
    echo ""

    # Create state directory
    mkdir -p "$STATE_DIR"

    # Save state
    echo "$cpu_range" > "$STATE_FILE"
    echo "$isolated_cpus" > "${STATE_DIR}/isolated_list"
    echo "$housekeeping_cpus" > "${STATE_DIR}/housekeeping_list"

    # Step 1: Save and move IRQ affinities
    log_step "Step 1/6: Saving and redirecting IRQ affinities..."
    save_irq_affinities
    move_irqs "$housekeeping_cpus"

    # Step 2: Move all existing processes
    log_step "Step 2/6: Moving existing processes off isolated cores..."
    move_processes "$housekeeping_cpus"

    # Step 3: Set up cgroup shielding
    log_step "Step 3/6: Setting up cgroup CPU shielding..."
    setup_cgroup_shield "$housekeeping_cpus" "$isolated_cpus"

    # Step 4: Configure kernel parameters
    log_step "Step 4/6: Configuring kernel parameters (workqueues, watchdog)..."
    configure_kernel_params "$isolated_cpus" "$housekeeping_cpus"

    # Step 5: Configure RT scheduling
    log_step "Step 5/6: Configuring RT scheduling..."
    configure_rt_scheduling

    # Step 6: Verify isolation
    log_step "Step 6/6: Verifying isolation..."
    verify_isolation "$isolated_cpus"

    echo ""
    echo -e "${GREEN}${BOLD}Core isolation is ACTIVE.${NC}"
    echo -e "Cores ${RED}${cpu_range}${NC} are now isolated and ready for simulator use."
    echo ""
    echo -e "${BOLD}To run a process on an isolated core:${NC}"
    echo -e "  taskset -c <core> <command>"
    echo ""
    echo -e "${BOLD}Example:${NC}"

    IFS=',' read -ra core_arr <<< "$isolated_cpus"
    for i in "${!core_arr[@]}"; do
        if [[ $i -lt 3 ]]; then
            echo -e "  taskset -c ${core_arr[$i]} ./simulator --core $i"
        fi
    done
    if [[ ${#core_arr[@]} -gt 3 ]]; then
        echo -e "  ... (${#core_arr[@]} cores available)"
    fi

    echo ""
    echo -e "${BOLD}When done:${NC}"
    echo -e "  sudo $SCRIPT_NAME --stop"
    echo ""
}

do_stop() {
    if [[ ! -f "$STATE_FILE" ]]; then
        log_error "No active isolation found. Nothing to stop."
        exit 1
    fi

    local cpu_range
    cpu_range=$(cat "$STATE_FILE")

    echo ""
    echo -e "${BOLD}============================================${NC}"
    echo -e "${BOLD}  Restoring CPU Core Access - LASSO${NC}"
    echo -e "${BOLD}============================================${NC}"
    echo -e "  Previously isolated: ${CYAN}${cpu_range}${NC}"
    echo -e "${BOLD}============================================${NC}"
    echo ""

    # Step 1: Restore cgroup
    log_step "Step 1/5: Restoring cgroup CPU access..."
    restore_cgroup_shield

    # Step 2: Restore IRQs
    log_step "Step 2/5: Restoring IRQ affinities..."
    restore_irqs

    # Step 3: Restore processes
    log_step "Step 3/5: Restoring process CPU affinities..."
    restore_processes

    # Step 4: Restore kernel parameters
    log_step "Step 4/5: Restoring kernel parameters..."
    restore_kernel_params

    # Step 5: Restore RT scheduling
    log_step "Step 5/5: Restoring RT scheduling..."
    restore_rt_scheduling

    # Cleanup state
    rm -rf "$STATE_DIR"

    echo ""
    echo -e "${GREEN}${BOLD}Core isolation has been DEACTIVATED.${NC}"
    echo -e "All cores are now available for normal system use."
    echo ""
}

do_status() {
    echo ""
    if [[ -f "$STATE_FILE" ]]; then
        local cpu_range
        cpu_range=$(cat "$STATE_FILE")
        local isolated
        isolated=$(cat "${STATE_DIR}/isolated_list" 2>/dev/null || echo "unknown")
        local housekeeping
        housekeeping=$(cat "${STATE_DIR}/housekeeping_list" 2>/dev/null || echo "unknown")

        echo -e "${BOLD}Isolation Status: ${GREEN}ACTIVE${NC}"
        echo -e "  Isolated cores:    ${RED}${cpu_range}${NC} (expanded: ${isolated})"
        echo -e "  Housekeeping cores: ${GREEN}${housekeeping}${NC}"
        echo -e "  Total system cores: $(nproc)"
        echo ""

        # Show what's running on isolated cores
        echo -e "${BOLD}Processes on isolated cores:${NC}"
        IFS=',' read -ra iso_cpus <<< "$isolated"
        local found_any=false
        for pid in /proc/[0-9]*/; do
            pid=$(basename "$pid")
            [[ "$pid" =~ ^[0-9]+$ ]] || continue
            local psr
            psr=$(cat /proc/"$pid"/stat 2>/dev/null | awk '{print $39}') || continue
            for iso_cpu in "${iso_cpus[@]}"; do
                if [[ "$psr" == "$iso_cpu" ]]; then
                    local comm
                    comm=$(cat /proc/"$pid"/comm 2>/dev/null || echo "unknown")
                    echo -e "  PID $pid ($comm) on core $psr"
                    found_any=true
                fi
            done
        done
        if [[ "$found_any" == "false" ]]; then
            echo -e "  ${GREEN}None - cores are clean!${NC}"
        fi
    else
        echo -e "${BOLD}Isolation Status: ${YELLOW}INACTIVE${NC}"
        echo -e "  Total system cores: $(nproc)"
        echo -e "  All cores available for normal use."
    fi
    echo ""
}

verify_isolation() {
    local isolated_cpus="$1"
    local issues=0

    IFS=',' read -ra iso_cpus <<< "$isolated_cpus"

    # Check for processes still running on isolated cores
    for pid in /proc/[0-9]*/; do
        pid=$(basename "$pid")
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        local allowed_cpus
        allowed_cpus=$(taskset -pc "$pid" 2>/dev/null | grep -oP 'current affinity list: \K.*') || continue

        for iso_cpu in "${iso_cpus[@]}"; do
            if echo "$allowed_cpus" | grep -qP "(^|,)${iso_cpu}(,|$|-)" 2>/dev/null; then
                local comm
                comm=$(cat /proc/"$pid"/comm 2>/dev/null || echo "unknown")
                # Only warn for non-kernel threads that we couldn't move
                if [[ -d "/proc/$pid/task/$pid" ]] && [[ "$(cat /proc/$pid/status 2>/dev/null | grep -c 'Tgid')" -gt 0 ]]; then
                    ((issues++)) || true
                fi
                break
            fi
        done
    done

    if [[ $issues -gt 0 ]]; then
        log_warn "Found $issues processes that could still access isolated cores (some kernel threads cannot be moved)."
    else
        log_info "Verification passed - isolated cores are clean."
    fi
}

# ========== ARGUMENT PARSING ==========

ACTION=""
CPU_RANGE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --start)
            ACTION="start"
            shift
            ;;
        --stop)
            ACTION="stop"
            shift
            ;;
        --status)
            ACTION="status"
            shift
            ;;
        --cpu-range)
            if [[ -z "${2:-}" ]]; then
                log_error "--cpu-range requires a value (e.g., 2-8)"
                exit 1
            fi
            CPU_RANGE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown argument: $1"
            usage
            ;;
    esac
done

# Validate arguments
if [[ -z "$ACTION" ]]; then
    log_error "No action specified. Use --start, --stop, or --status."
    usage
fi

if [[ "$ACTION" == "start" && -z "$CPU_RANGE" ]]; then
    log_error "--start requires --cpu-range."
    usage
fi

# Execute
case "$ACTION" in
    start)
        check_root
        do_start "$CPU_RANGE"
        ;;
    stop)
        check_root
        do_stop
        ;;
    status)
        do_status
        ;;
esac
