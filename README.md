# Invigiflow 

Invigiflow is a web-based application designed to ease the process of scheduling and managing exam invigilation. It allows administrators to set up exam weeks, manage a database of teachers, define their availability, and automatically allocate invigilators to exam sessions.

## Key Features

- **User Authentication**
- **Exam Week Setup**
- **Teacher Database**
- **Exam Management**
- **Automated Allocation**
- **Export & Communication**

## Core Workflow

1.  **Setup**: The admin creates a new "Exam Week" with a name, timezone, and start/end dates.
2.  **Teacher Database**: The admin adds teachers to the system, either individually or by uploading a CSV file.
3.  **Exam List**: The admin adds the exam sessions that need invigilators.
4.  **Availability**: For each teacher, the admin defines periods of teacher unavailability.
5.  **Allocation**: The system runs an algorithm to distribute invigilation duties, taking into account teacher availability and workload.
6.  **Review & Finalize**: The admin reviews the allocation (by exam or teacher), makes manual edits if needed, and confirms the final schedule.
