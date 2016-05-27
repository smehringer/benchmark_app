/**
 * BenchmarkExecutor:
 *
 * Events:
 *   'initialize': (benchmark_queue)
 *       Will be called after the benchmark queue was filled and before the
 *       execution of the benchmarks.
 *
 *   'done': (benchmark_queue)
 *       Will be called after the last benchmark was executed.
 *
 *
 *   'setup': (benchmark_process, benchmark_queue)
 *       Will be called before a benchmark will be executed.
 *
 *   'spawned': (process, benchmark_process, benchmark_queue)
 *       Will be called after the benchmark process was started.
 *
 *   'result': (benchmark_process, benchmark_queue)
 *       Will be called after a benchmark terminated. Independent of whether the
 *       benchmark_process was successful, failed or canceled.
 *
 *       ```javascript
 *       benchmark_process.state // either SUCCESS, FAILURE, CANCELED
 *       ```
 *
 *   'error': (error, benchmark_process, benchmark_queue)
 *       Will be called if an error occurred executing the benchmark.
 *
 *   'canceled': (benchmark_process, benchmark_queue)
 *       Will be called after the current running benchmark process was stopped.
 *
 */
;(function(root, factory) {

    if (typeof define === 'function' && define.amd) {
        define(factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.BenchmarkExecutor = factory();
    }

})(this, function() {
    // using strict is important, otherwise the `const` within loops won't work
    // for older nodejs versions
    // see https://github.com/eslint/eslint/issues/3104#issuecomment-157726737
    "use strict";

    const fs = require('fs');
    const process = require('process');
    const path = require('path');
    const EventEmitter = require('events');
    const extend = require('extend');
    const ValidatorExecutor = require('./validator_executor');

    var self = new EventEmitter();

    /**
     * A list of all output/result files generated by the benchmarks.
     */
    self.result_files = function() {
        var files = [];
        const queue = self.benchmark_queue();
        for (const benchmark of queue) {
            files.push(benchmark.result_file);
        }
        return files;
    };

    var BenchmarkQueue = extend([], {
        system: undefined,
        project: undefined,
        started_at: undefined,

        add_process: function(benchmark_process) {
            this.push(extend(Object.create(BenchmarkProcess), benchmark_process));
        },

        /**
         * Returns/sets the current executed benchmark.
         *
         * ```
         * // returns the current executed benchmark in the queue
         * var current_process = queue.current_process();
         * ```
         *
         * ```
         * // sets the current executed benchmark
         * var current_process = queue.current_process(queue_id);
         * ```
         *
         * @param  int queue_id The position of the benchmark in the queue.
         * @return BenchmarkProcess
         */
        current_process: function(queue_id) {
            if (queue_id !== undefined) {
                this._queue_id = queue_id;
            }
            return this[this._queue_id];
        },

        total_expected_runtime: function() {
            return this.reduce(function(sum, benchmark_process) {
                return sum + benchmark_process.expected_runtime;
            }, 0);
        },

        total_runtime: function() {
            return this.reduce(function(sum, benchmark_process) {
                return sum + benchmark_process.runtime;
            }, 0);
        }
    });

    var BenchmarkProcess = {
        queue_id: 0,
        benchmark_id: undefined,
        benchmark_name: undefined,
        runtime: undefined,
        expected_runtime: 0,
        threads: 1,
        repeat: 1,
        repeats: 1,

        state: 'QUEUED',
        stdout: "",
        stderr: "",
        start_time: undefined,
        result_file: undefined,

        pid: undefined,
        shell_command: '',
        shell_args: [],
        error: undefined,

        getPid: function(){
            return this.pid;
        },
        setPid: function(pid){
            this.pid = pid;
        }
    };

    /**
     * Creates a new benchmark queue and sets it.
     *
     * @return BenchmarkQueue
     */
    self.new_benchmark_queue = function() {
        var queue = Object.create(BenchmarkQueue);
        return self.benchmark_queue(queue);
    };

    /**
     * Returns/sets the benchmarks to execute.
     *
     * ```
     * // returns the benchmark queue
     * var queue = self.benchmark_queue();
     * ```
     *
     * ```
     * // sets the benchmark queue
     * var new_queue = self.benchmark_queue(new_queue);
     * ```
     *
     * @param  BenchmarkQueue queue
     * @return BenchmarkQueue         the current benchmark queue.
     */
    self.benchmark_queue = function(queue) {
        if (queue !== undefined) {
            this._benchmark_queue = queue;
        }
        return this._benchmark_queue;
    };

    self._initialize = function() {
        const strftime = require('strftime');
        const Configure = require('./configure');
        const shell_parse = require('shell-quote').parse;

        // reset canceled state
        self.canceled = false;

        // reset benchmark queue
        var benchmark_queue = self.new_benchmark_queue();
        var started_at = new Date();

        // make sure that the project and system informations will stay the
        // same, s.t. multiple saves will result in the same output.
        extend(true, benchmark_queue, {
            project: Configure.project_infos(),
            system: Configure.system_infos({
                started_at: strftime('%F %T', started_at)
            }),
            started_at: started_at
        });
        const max_threads = benchmark_queue.system.threads;

        var queue_id = 0;
        const threads = max_threads == 1 ? [1] : [1, max_threads];

        // add benchmarks to the benchmark_queue.
        for (var benchmark_id in Configure.benchmarks()) {
            const benchmark = Configure.benchmark(benchmark_id);

            if(!benchmark.execute) {
                continue;
            }

            for (const thread of threads) {
                const core = (thread == 1 ? 'single_core' : 'multi_core');
                const repeats = benchmark.repeats ? benchmark.repeats : 1;

                for (var i = 0; i < repeats; i++) {
                    const repeat_name = repeats == 1 ? '' : "." + i;
                    const result_file = './results/' + benchmark_id + '.' + core + repeat_name + '.result.txt';
                    const thread_name = " -tc " + thread;

                    var shell_args = shell_parse(benchmark.command);
                    shell_args = shell_args.concat([result_file, '-tc', thread]);

                    benchmark_queue.add_process({
                        queue_id: queue_id++,
                        benchmark_id: benchmark_id,
                        benchmark_name: benchmark_id + repeat_name + thread_name,
                        threads: thread,
                        repeat: i+1,
                        repeats: repeats,
                        shell_command: shell_args[0],
                        shell_args: shell_args.slice(1),
                        result_file: result_file,
                        expected_runtime: benchmark.expected_runtime
                    });
                }
            }
        }
    };

    /**
     * Deletes all output files of the executed benchmarks.
     */
    self.clear_results = function(){
        self.result_files().forEach(function(filename){
            const file = path.resolve(filename);
            try {
                fs.accessSync(file, fs.W_OK);
            } catch (e) {
                return;
            }
            try {
                fs.unlink(file);
            } catch (e) {
                console.warn(e);
            }
        });
    };

    /**
     * Start the benchmark execution. This will execute all benchmarks in the
     * `benchmark_queue`.
     */
    self.run = function(){
        self._initialize();
        self.clear_results();

        const benchmark_queue = self.benchmark_queue();
        self.benchmark_queue().current_process(0);

        self.emit('initialize', benchmark_queue);

        self._runEach(0);
    };

    /**
     * Converts `process.hrtime` into seconds.
     *
     * @param  array hrtime returned by process.hrtime.
     * @return double
     */
    var to_secs = function(hrtime){
        return hrtime[0] + hrtime[1] * 1e-9;
    };


    /**
     * this handler will be called, if an error occurred trying to start a
     * benchmark process or during the execution of the benchmark process.
     *
     * @param Object error error.message contains the error message
     */
    var error_handler = function(error){
        var benchmark_queue = self.benchmark_queue();
        var current_process = benchmark_queue.current_process();

        current_process.error = error;
        current_process.state = 'FAILURE';

        self.emit('error', error, current_process, benchmark_queue);
    };

    self.onProcessTerminated = function(code) {
        const benchmark_queue = self.benchmark_queue();
        const current_process = benchmark_queue.current_process();
        const runtime = process.hrtime(current_process.start_time);
        const queue_id = current_process.queue_id;
        current_process.runtime = to_secs(runtime);

        if (current_process.state === 'QUEUED') {
            current_process.state = 'SUCCESS';
            if (code != 0) {
                // this will set state = 'FAILURE'
                error_handler({
                    message: "non-zero exit status: " + code
                });
            }
        }

        ValidatorExecutor.once('result', (validator) => {
            current_process.validator = validator;

            // display successful/failed/aborted execution in the GUI
            self.emit('result', current_process, benchmark_queue);

            // execute next benchmark in the queue
            self._runEach(queue_id+1);
        });
        ValidatorExecutor.validate(current_process);
    };

    /**
     * This function executes every benchmark in the queue and does the error
     * handling.
     *
     * @param  int queue_id
     */
    self._runEach = function(queue_id){
        const Configure = require('./configure');
        const path = require('path');
        const spawn = require('child_process').spawn;
        const benchmark_queue = self.benchmark_queue();

        // stop if all benchmarks were executed
        if (queue_id >= benchmark_queue.length) {
            self.emit('done', benchmark_queue);
            return;
        }

        if (self.canceled) {
            return;
        }

        // set the current process to be at the current queue_id
        var current_process = benchmark_queue.current_process(queue_id);
        self.emit('setup', current_process, benchmark_queue);

        var child_process;
        current_process.start_time = process.hrtime();
        try {
            child_process = spawn(current_process.shell_command, current_process.shell_args, {
                cwd: Configure.execCwd,
                detached: true
            });
        } catch(err){
            error_handler({
               message: err
            });
            self.onProcessTerminated(-1);
            return
        }
        current_process.setPid(child_process.pid);
        self.emit('spawned', child_process, current_process, benchmark_queue);

        // handles process termination, i.e. this handler will be executed after
        // a benchmark process was closed or aborted.
        child_process.on('close', self.onProcessTerminated);
        child_process.stdout.on('data', (chunk) => {
            current_process.stdout += chunk;
        });
        child_process.stderr.on('data', (chunk) => {
            current_process.stderr += chunk;
        });
        child_process.stdout.on('error', error_handler);
        child_process.stderr.on('error', error_handler);
        child_process.on('error', function(error){
            error_handler({
                message: "Starting program failed: " + error.message
            });
        });
    };

    /**
     * Abort the current running benchmark.
     */
    self.cancel = function(){
        var benchmark_queue = self.benchmark_queue();
        var current_process = benchmark_queue.current_process();
        try{
            current_process.state = 'CANCELED';
            self.canceled = true;
            process.kill("-" + current_process.getPid());
        } catch(err){
            console.error(err);
            // first emit error event, after that emit cancel event
            error_handler({
                message: err
            });
        }

        self.emit('canceled', current_process, benchmark_queue);
        return true;
    };

    return self;
});
