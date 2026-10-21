import { Dialect } from '../types/index.js';
export interface TableCapacityEstimate {
    table_name: string;
    projected_rows: number;
    avg_row_bytes_including_header: number;
    estimated_table_size_gb: number;
    estimated_indexes_size_gb: number;
    total_footprint_gb: number;
}
export interface CalculateCapacityOutput {
    capacity_estimation: {
        tables: TableCapacityEstimate[];
        total_database_footprint_gb: number;
        working_set_fits_in_ram: boolean;
        memory_fit_analysis: string;
    };
    engine_tuning_recommendation: {
        config_file: 'postgresql.conf' | 'my.cnf';
        parameters: Record<string, string>;
        config_snippet: string;
    };
}
export declare function calculateDbCapacityAndConfig(input: {
    dialect: Dialect;
    schema_ddl?: string;
    estimated_rows_per_table?: Record<string, number>;
    server_hardware?: {
        vcpu?: number;
        ram_gb?: number;
        storage_type?: 'nvme' | 'ssd' | 'hdd';
        workload_type?: 'oltp' | 'analytics' | 'mixed';
        max_connections?: number;
    };
}): CalculateCapacityOutput;
